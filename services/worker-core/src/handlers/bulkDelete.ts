import { getTargetDb, coerce } from '@conductor/targetdb';
import { report, type JobContext } from '@conductor/worker-runtime';
import { runRowJob, sourceFieldFor, firstUnique } from '../rowPipeline.js';
import { readRows } from '../source.js';

// ─────────────────────────────────────────────────────────────────────────────
// bulk_delete (spec §11): resolve the target set from keys; return a DRY-RUN
// count first (options.dryRun); SOFT-DELETE by default (sets deleted_at);
// HARD-DELETE only with options.hardDelete AND under a safety threshold
// (options.maxDelete, overridable with options.confirm). Provider-neutral
// (PostgreSQL / SQL Server) via the @conductor/targetdb dialect API.
// ─────────────────────────────────────────────────────────────────────────────

export async function bulkDelete(ctx: JobContext): Promise<void> {
  const { job, project, entity, envelope } = ctx;
  const jobId = job.id;
  const opts = envelope.options;
  const persisted = (job.parameters_jsonb.options ?? {}) as Record<string, unknown>;
  const db = await getTargetDb(project);
  const schema = project.schema || 'public';
  const colTypes = await db.introspectColumns(schema, entity.targetTable);
  const mapping = entity.mapping;

  const matchCol = (persisted.matchOn as string) || firstUnique(colTypes, mapping) || entity.primaryKey;
  const matchSrc = sourceFieldFor(mapping, matchCol);
  if (!matchSrc) throw new Error(`bulk_delete: no source field maps to match column '${matchCol}'`);
  const tbl = db.qualify(schema, entity.targetTable);
  const softCapable = colTypes.has('deleted_at');
  const hard = opts.hardDelete === true;

  // Safety threshold for hard deletes (spec §11).
  if (hard && !persisted.confirm) {
    const maxDelete = Number(persisted.maxDelete ?? 1000);
    const count = (await readRows(ctx)).length;
    if (count > maxDelete) {
      const msg = `refusing hard-delete of ${count} rows (> maxDelete ${maxDelete}); set options.confirm=true to override`;
      await report.failJob(jobId, msg);
      await report.event('job.failed', msg, { jobId, projectId: project.id });
      throw new Error(msg);
    }
  }

  const result = await runRowJob(
    ctx,
    async ({ value, db }) => {
      const key = coerce(value[matchSrc], colTypes.get(matchCol));
      if (key === null) return { processed: false, error: { field: matchCol, rule: 'missing_key', message: 'no delete key' } };

      if (opts.dryRun) {
        const live = softCapable
          ? `${db.ident(matchCol)} = ? AND ${db.ident('deleted_at')} IS NULL`
          : `${db.ident(matchCol)} = ?`;
        return { processed: await db.existsOne(tbl, live, [key]) }; // "would delete"
      }
      if (hard) {
        const res = await db.query(`DELETE FROM ${tbl} WHERE ${db.ident(matchCol)} = ?`, [key]);
        return { processed: res.rowCount > 0 };
      }
      if (!softCapable) {
        return { processed: false, error: { field: matchCol, rule: 'no_soft_delete', message: 'target has no deleted_at column; pass options.hardDelete' } };
      }
      const res = await db.query(
        `UPDATE ${tbl} SET ${db.ident('deleted_at')} = ${db.now()} WHERE ${db.ident(matchCol)} = ? AND ${db.ident('deleted_at')} IS NULL`,
        [key],
      );
      return { processed: res.rowCount > 0 };
    },
    { validate: false },
  );

  const mode = opts.dryRun ? 'dry-run' : hard ? 'hard-deleted' : 'soft-deleted';
  const summary = `${mode} ${result.processed}/${result.total} rows, ${result.errors} errors`;
  await report.completeJob(jobId, summary);
  await report.endProgress(jobId, 'completed');
  await report.event('job.completed', summary, { jobId, projectId: project.id });
  await report.log(jobId, 'info', summary);
}
