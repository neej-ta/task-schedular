import { getTargetDb, coerce } from '@conductor/targetdb';
import { report, type JobContext } from '@conductor/worker-runtime';
import { runRowJob, sourceFieldFor, firstUnique } from '../rowPipeline.js';

// ─────────────────────────────────────────────────────────────────────────────
// bulk_update (spec §11): match on a key, write only the mapped fields, with
// OPTIMISTIC CONCURRENCY when an `optimisticColumn` (e.g. updated_at) is given.
// Rules still validate each row. UPDATE is naturally idempotent. Provider-neutral
// (PostgreSQL / SQL Server) via the @conductor/targetdb dialect API.
//   options: { matchOn?: targetCol, optimisticColumn?: targetCol }
// ─────────────────────────────────────────────────────────────────────────────

export async function bulkUpdate(ctx: JobContext): Promise<void> {
  const { job, project, entity } = ctx;
  const jobId = job.id;
  const db = await getTargetDb(project);
  const schema = project.schema || 'public';
  const colTypes = await db.introspectColumns(schema, entity.targetTable);
  const mapping = entity.mapping;

  const persistedOpts = (job.parameters_jsonb.options ?? {}) as Record<string, unknown>;
  const matchCol = (persistedOpts.matchOn as string) || firstUnique(colTypes, mapping) || entity.primaryKey;
  const matchSrc = sourceFieldFor(mapping, matchCol);
  if (!matchSrc) throw new Error(`bulk_update: no source field maps to match column '${matchCol}'`);
  const optimisticCol = persistedOpts.optimisticColumn as string | undefined;
  const hasUpdatedAt = colTypes.has('updated_at');

  // Columns to write = mapped target cols except the match column.
  const writeSrcFields = Object.keys(mapping).filter((sf) => mapping[sf] !== matchCol);
  if (writeSrcFields.length === 0 && !hasUpdatedAt) {
    throw new Error(`bulk_update: nothing to update (only the match column '${matchCol}' is mapped)`);
  }
  const tbl = db.qualify(schema, entity.targetTable);

  const result = await runRowJob(ctx, async ({ source: _source, value, db }) => {
    const setSql = writeSrcFields.map((sf) => `${db.ident(mapping[sf]!)} = ?`);
    const params: unknown[] = writeSrcFields.map((sf) => coerce(value[sf], colTypes.get(mapping[sf]!)));
    if (hasUpdatedAt) setSql.push(`${db.ident('updated_at')} = ${db.now()}`);

    let where = `${db.ident(matchCol)} = ?`;
    params.push(coerce(value[matchSrc], colTypes.get(matchCol)));
    if (optimisticCol && value[`_${optimisticCol}`] !== undefined) {
      where += ` AND ${db.ident(optimisticCol)} = ?`;
      params.push(coerce(value[`_${optimisticCol}`], colTypes.get(optimisticCol)));
    }

    const res = await db.query(`UPDATE ${tbl} SET ${setSql.join(', ')} WHERE ${where}`, params);
    if (res.rowCount > 0) return { processed: true };

    // Distinguish optimistic conflict from not-found.
    if (optimisticCol && value[`_${optimisticCol}`] !== undefined) {
      const exists = await db.existsOne(tbl, `${db.ident(matchCol)} = ?`, [coerce(value[matchSrc], colTypes.get(matchCol))]);
      if (exists) {
        return { processed: false, error: { field: optimisticCol, rule: 'optimistic_conflict', message: 'row changed since read' } };
      }
    }
    return { processed: false, error: { field: matchCol, rule: 'not_found', message: `no row with ${matchCol}=${value[matchSrc]}` } };
  });

  const summary = `updated ${result.processed}/${result.total} rows, ${result.errors} errors`;
  await report.completeJob(jobId, summary);
  await report.endProgress(jobId, 'completed');
  await report.event('job.completed', summary, { jobId, projectId: project.id });
  await report.log(jobId, 'info', summary);
}
