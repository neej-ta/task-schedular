import { getObjectText, putObject, parseS3Url, defaultBucket } from '@conductor/storage';
import { enqueueJob } from '@conductor/core';
import { report, type JobContext } from '@conductor/worker-runtime';

// file_inbound (spec §11): fetch a file from the inbound source (S3 here; SFTP/FTP
// would use an sftp/ftp client — noted), stage it into object storage, then hand
// it to the core import pipeline by ENQUEUEING a bulk_import / xml_integration.
export async function fileInbound(ctx: JobContext): Promise<void> {
  const { job, project, envelope } = ctx;
  const jobId = job.id;
  const src = envelope.source as { kind: string; location?: string };
  const location = src.location ?? (job.source_jsonb.location as string | undefined);
  if (!location) throw new Error('file_inbound: no source.location');

  await report.event('job.started', `file_inbound fetching ${location}`, { jobId, projectId: project.id });
  await report.log(jobId, 'info', `fetching ${location} (kind=${src.kind})`);

  if (!location.startsWith('s3://')) {
    throw new Error(`file_inbound: only s3:// sources supported in this build (got ${src.kind})`);
  }
  const { bucket, key } = parseS3Url(location);
  const text = await getObjectText(bucket, key);

  const ext = (key.split('.').pop() ?? 'csv').toLowerCase();
  const stagedKey = `inbound-staged/${jobId}.${ext}`;
  await putObject(stagedKey, text);
  await report.log(jobId, 'info', `staged ${text.length} bytes → s3://${defaultBucket()}/${stagedKey}`);

  const importKind = ext === 'xml' ? 'xml' : ext === 'json' ? 'json' : 'csv';
  const importType = ext === 'xml' ? 'xml_integration' : 'bulk_import';
  const res = await enqueueJob({
    projectId: project.id,
    entity: job.entity,
    type: importType,
    source: { kind: importKind, location: `s3://${defaultBucket()}/${stagedKey}` },
    destination: job.destination_jsonb,
    options: (job.parameters_jsonb.options as Record<string, unknown>) ?? {},
  });

  const summary = `fetched + staged; enqueued ${importType} job ${res.jobId}`;
  await report.completeJob(jobId, summary);
  await report.event('job.completed', summary, { jobId, projectId: project.id });
  await report.log(jobId, 'info', summary);
}
