import { report, type JobContext } from '@conductor/worker-runtime';
import { postJson } from '../http.js';

// webhook (scheduler-only trigger): on each scheduled fire, POST an
// authenticated request to a target project's OWN job endpoint and let that
// project run its own workflow. This is how Conductor owns scheduling while
// execution stays per-project (Node `/internal/jobs/run`, or the equivalent .NET
// endpoint). No target-DB access — just an SSRF-guarded HTTP call with backoff.
//
// Job definition config lives in `destination`:
//   destination.location           → the project endpoint URL (required)
//   destination.options.token      → shared secret sent as `Authorization: Bearer`
//   destination.options.jobType    → which per-project job to trigger ("file", "restPull", …)
//   destination.options.body       → optional explicit JSON body (overrides the default)
//   destination.options.maxParallel→ optional, forwarded in the default body
export async function webhook(ctx: JobContext): Promise<void> {
  const { job, project, envelope } = ctx;
  const jobId = job.id;
  const dest = envelope.destination as { location?: string; options?: Record<string, unknown> };

  const url = dest.location;
  if (!url) throw new Error('webhook: no destination.location (target endpoint URL)');

  const options = dest.options ?? {};
  const token = options.token as string | undefined;
  const jobType = options.jobType as string | undefined;

  // Default body matches the project trigger contract:
  // { type, maxParallel?, correlationId } — correlationId lets the project's
  // task-status/logs be traced back to this Conductor job.
  // An explicit destination.options.body wins if provided.
  const body =
    (options.body as Record<string, unknown> | undefined) ??
    (jobType
      ? {
          type: jobType,
          correlationId: jobId,
          ...(options.maxParallel != null ? { maxParallel: Number(options.maxParallel) } : {}),
        }
      : {});

  await report.event('job.started', `webhook → ${url}${jobType ? ` (type=${jobType})` : ''}`, {
    jobId,
    projectId: project.id,
  });

  try {
    await postJson(url, body, { token, allowlist: project.allowlist_hosts });
  } catch (err) {
    const summary = `webhook POST ${url} failed: ${(err as Error).message}`;
    await report.failJob(jobId, summary);
    await report.event('job.failed', summary, { jobId, projectId: project.id });
    await report.log(jobId, 'error', summary);
    throw err; // let the Runner apply retry/backoff → DLQ
  }

  const summary = `triggered ${jobType ?? 'job'} on ${url}`;
  await report.completeJob(jobId, summary);
  await report.event('job.completed', summary, { jobId, projectId: project.id });
  await report.log(jobId, 'info', summary);
}
