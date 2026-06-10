import { getTargetPool, quoteIdent, introspectColumns } from '@conductor/targetdb';
import { putObject, parseS3Url, defaultBucket } from '@conductor/storage';
import { report, type JobContext } from '@conductor/worker-runtime';
import { toCsv, toJson } from '../serialize.js';

// file_outbound (spec §11): query the target DB → transform → serialize
// (csv/json) → push to object storage. The pipeline "in reverse".
export async function fileOutbound(ctx: JobContext): Promise<void> {
  const { job, project, entity, envelope } = ctx;
  const jobId = job.id;
  const pool = await getTargetPool(project);
  const schema = project.schema || 'public';
  const mapping = entity.mapping;
  const targetCols = Object.values(mapping);
  const colTypes = await introspectColumns(pool, schema, entity.targetTable);
  const softFilter = colTypes.has('deleted_at') ? 'WHERE deleted_at IS NULL' : '';

  await report.event('job.started', 'file_outbound querying target', { jobId, projectId: project.id });
  const sql = `SELECT ${targetCols.map(quoteIdent).join(', ')}
                 FROM ${quoteIdent(schema)}.${quoteIdent(entity.targetTable)} ${softFilter}`;
  const { rows } = await pool.query<Record<string, unknown>>(sql);
  await report.log(jobId, 'info', `queried ${rows.length} rows from ${entity.targetTable}`);

  const dest = envelope.destination as { location?: string; options?: Record<string, unknown> };
  const fmt = (dest.options?.format as string) || 'csv';
  const body = fmt === 'json' ? toJson(rows, mapping) : toCsv(rows, mapping);

  const target = dest.location ?? `s3://${defaultBucket()}/exports/${entity.name}-${jobId}.${fmt}`;
  const { bucket, key } = parseS3Url(target);
  await putObject(key, body, bucket);

  const summary = `exported ${rows.length} rows (${fmt}) → ${target}`;
  await report.completeJob(jobId, summary);
  await report.event('job.completed', summary, { jobId, projectId: project.id });
  await report.log(jobId, 'info', summary);
}
