import { putObject, defaultBucket } from '@conductor/storage';
import { enqueueJob } from '@conductor/core';
import { report, type JobContext } from '@conductor/worker-runtime';
import { fetchJson } from '../http.js';

// rest_pull (spec §11): paginate an external API (auth- & rate-limit-aware via
// backoff) → stage as JSON → upsert via the core pipeline (enqueue bulk_insert).
export async function restPull(ctx: JobContext): Promise<void> {
  const { job, project, envelope } = ctx;
  const jobId = job.id;
  const src = envelope.source as { location?: string; options?: Record<string, unknown> };
  const base = src.location ?? (job.source_jsonb.location as string | undefined);
  if (!base) throw new Error('rest_pull: no source.location (API base URL)');
  const pageSize = Number(src.options?.pageSize ?? 100);
  const token = src.options?.token as string | undefined;

  await report.event('job.started', `rest_pull from ${base}`, { jobId, projectId: project.id });

  const all: unknown[] = [];
  let page = 1;
  for (; page <= 1000; page++) {
    const sep = base.includes('?') ? '&' : '?';
    const data = await fetchJson(`${base}${sep}page=${page}&pageSize=${pageSize}`, {
      token,
      allowlist: project.allowlist_hosts,
    });
    const items = Array.isArray(data)
      ? data
      : ((data as { items?: unknown[]; rows?: unknown[] }).items ?? (data as { rows?: unknown[] }).rows ?? []);
    if (items.length === 0) break;
    all.push(...items);
    await report.log(jobId, 'info', `pulled page ${page}: ${items.length} (total ${all.length})`);
    if (items.length < pageSize) break;
  }

  const stagedKey = `rest-pull/${jobId}.json`;
  await putObject(stagedKey, JSON.stringify(all));
  const res = await enqueueJob({
    projectId: project.id,
    entity: job.entity,
    type: 'bulk_insert',
    source: { kind: 'json', location: `s3://${defaultBucket()}/${stagedKey}` },
    destination: job.destination_jsonb,
    options: (job.parameters_jsonb.options as Record<string, unknown>) ?? {},
  });

  const summary = `pulled ${all.length} records over ${page} page(s); enqueued bulk_insert ${res.jobId}`;
  await report.completeJob(jobId, summary);
  await report.event('job.completed', summary, { jobId, projectId: project.id });
  await report.log(jobId, 'info', summary);
}
