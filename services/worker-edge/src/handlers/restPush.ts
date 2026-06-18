import { getTargetDb } from '@conductor/targetdb';
import { report, type JobContext } from '@conductor/worker-runtime';
import { postJson } from '../http.js';
import { rowToSource } from '../serialize.js';

// rest_push (spec §11): read rows from the target → POST in batches with
// exponential backoff → track per-batch success; partial failures are recorded
// and the job reports how many pushed vs failed (resumable by re-running).
export async function restPush(ctx: JobContext): Promise<void> {
  const { job, project, entity, envelope } = ctx;
  const jobId = job.id;
  const dest = envelope.destination as { location?: string; options?: Record<string, unknown> };
  const url = dest.location;
  if (!url) throw new Error('rest_push: no destination.location (API URL)');
  const batchSize = Number(dest.options?.batchSize ?? 50);
  const token = dest.options?.token as string | undefined;

  const db = await getTargetDb(project);
  const schema = project.schema || 'public';
  const mapping = entity.mapping;
  const targetCols = Object.values(mapping);
  const colTypes = await db.introspectColumns(schema, entity.targetTable);
  const softFilter = colTypes.has('deleted_at') ? `WHERE ${db.ident('deleted_at')} IS NULL` : '';

  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT ${targetCols.map((c) => db.ident(c)).join(', ')} FROM ${db.qualify(schema, entity.targetTable)} ${softFilter}`,
  );
  await report.event('job.started', `rest_push ${rows.length} rows → ${url}`, { jobId, projectId: project.id });

  let pushed = 0;
  let failed = 0;
  const batches = Math.ceil(rows.length / batchSize);
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize).map((r) => rowToSource(r, mapping));
    const batchNo = Math.floor(i / batchSize) + 1;
    try {
      await postJson(url, batch, { token, allowlist: project.allowlist_hosts });
      pushed += batch.length;
      await report.log(jobId, 'info', `pushed batch ${batchNo}/${batches} (${batch.length})`);
    } catch (err) {
      failed += batch.length;
      await report.log(jobId, 'warn', `batch ${batchNo}/${batches} failed: ${(err as Error).message}`);
    }
  }

  const summary = `pushed ${pushed}/${rows.length} records, ${failed} failed`;
  if (failed > 0) await report.failJob(jobId, summary);
  else await report.completeJob(jobId, summary);
  await report.event(failed > 0 ? 'job.failed' : 'job.completed', summary, { jobId, projectId: project.id });
  await report.log(jobId, 'info', summary);
}
