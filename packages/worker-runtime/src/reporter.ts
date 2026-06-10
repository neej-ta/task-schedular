import { query } from '@conductor/db';
import {
  publishJob,
  publishActivity,
  initProgress,
  bumpProgress,
  setProgressStatus,
} from '@conductor/realtime';

// Persists job-scoped visibility to the control plane (queryable) AND publishes
// it to Redis for live SSE/WS streaming (spec §16). Everything correlates by
// jobId / batchId / chunkIndex. Shared by worker-core and worker-edge.

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const EVENT_STATUS: Record<string, string> = {
  'job.queued': 'queued',
  'job.started': 'running',
  'job.completed': 'completed',
  'job.failed': 'failed',
  'job.retrying': 'retrying',
  'job.cancelled': 'cancelled',
};

export async function log(
  jobId: string,
  level: Level,
  message: string,
  opts: { batchId?: string; chunkIndex?: number; data?: unknown } = {},
): Promise<void> {
  const { rows } = await query<{ id: number; ts: string }>(
    `INSERT INTO job_logs (job_id, batch_id, chunk_index, level, message, data_jsonb)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, ts`,
    [jobId, opts.batchId ?? null, opts.chunkIndex ?? null, level, message, opts.data ? JSON.stringify(opts.data) : null],
  );
  const row = rows[0]!;
  await publishJob(jobId, {
    kind: 'log',
    id: row.id,
    ts: new Date(row.ts).toISOString(),
    level,
    message,
    chunkIndex: opts.chunkIndex ?? null,
  }).catch(() => {});
}

export async function event(
  type: string,
  message: string,
  opts: { jobId?: string; projectId?: string; actor?: string; data?: unknown } = {},
): Promise<void> {
  await query(
    `INSERT INTO job_events (job_id, project_id, type, actor, message, data_jsonb)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [opts.jobId ?? null, opts.projectId ?? null, type, opts.actor ?? 'worker', message, opts.data ? JSON.stringify(opts.data) : null],
  );
  const ts = new Date().toISOString();
  await publishActivity({ ts, type, jobId: opts.jobId, projectId: opts.projectId, actor: opts.actor ?? 'worker', message }).catch(() => {});
  if (opts.jobId && EVENT_STATUS[type]) {
    await publishJob(opts.jobId, { kind: 'state', status: EVENT_STATUS[type]!, ts, message }).catch(() => {});
  }
}

export async function recordRowError(
  jobId: string,
  batchId: string,
  rowNumber: number,
  field: string | null,
  rule: string,
  message: string,
  raw?: unknown,
): Promise<void> {
  await query(
    `INSERT INTO job_errors (job_id, batch_id, row_number, field, rule, message, raw_jsonb)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [jobId, batchId, rowNumber, field, rule, message, raw ? JSON.stringify(raw) : null],
  );
}

/**
 * Atomically claim a job for execution (idempotency for at-least-once delivery):
 * only a queued/retrying job transitions to running. Returns false if another
 * worker took it or it's already finished/cancelled — caller should ack & skip.
 */
export async function claimJob(jobId: string, workerId: string): Promise<boolean> {
  // Claim queued/retrying jobs normally. ALSO reclaim a 'running' job whose
  // owning worker has a stale heartbeat — i.e. it crashed and RabbitMQ
  // redelivered the message (dead-worker recovery, spec §13). A live owner's
  // job is NOT reclaimed, so we never double-run.
  const { rowCount } = await query(
    `UPDATE jobs SET status='running', started_at=now(), worker_id=$2
       WHERE id=$1 AND (
         status IN ('queued','retrying')
         OR (status='running' AND worker_id IS DISTINCT FROM $2
             AND NOT EXISTS (
               SELECT 1 FROM worker_nodes w
                WHERE w.id = jobs.worker_id
                  AND w.last_heartbeat_at > now() - interval '45 seconds'))
       )`,
    [jobId, workerId],
  );
  return (rowCount ?? 0) > 0;
}

export async function jobStatus(jobId: string): Promise<string | null> {
  const { rows } = await query<{ status: string }>('SELECT status FROM jobs WHERE id=$1', [jobId]);
  return rows[0]?.status ?? null;
}

export async function completeJob(jobId: string, summary?: string): Promise<void> {
  await query(`UPDATE jobs SET status='completed', finished_at=now(), error_summary=$2 WHERE id=$1`, [jobId, summary ?? null]);
}

export async function failJob(jobId: string, errorSummary: string): Promise<void> {
  await query(`UPDATE jobs SET status='failed', finished_at=now(), error_summary=$2 WHERE id=$1`, [jobId, errorSummary]);
}

export async function retryingJob(jobId: string, attempt: number): Promise<void> {
  await query(`UPDATE jobs SET status='retrying', attempt=$2 WHERE id=$1`, [jobId, attempt]);
}

export async function createBatch(
  jobId: string,
  totalRows: number,
  chunkSize: number,
  chunkCount: number,
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO batches (job_id, total_rows, chunk_size, chunk_count, chunks_remaining)
     VALUES ($1,$2,$3,$4,$4) RETURNING id`,
    [jobId, totalRows, chunkSize, chunkCount],
  );
  return rows[0]!.id;
}

export async function createChunk(
  batchId: string,
  index: number,
  rowStart: number,
  rowEnd: number,
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO batch_chunks (batch_id, chunk_index, row_start, row_end, status)
     VALUES ($1,$2,$3,$4,'pending') RETURNING id`,
    [batchId, index, rowStart, rowEnd],
  );
  return rows[0]!.id;
}

export async function chunkRunning(chunkId: string): Promise<void> {
  await query(`UPDATE batch_chunks SET status='running', started_at=now() WHERE id=$1`, [chunkId]);
}

export async function chunkDone(batchId: string, chunkId: string, processed: number, errorCount: number): Promise<void> {
  await query(`UPDATE batch_chunks SET status='completed', processed_count=$2, finished_at=now() WHERE id=$1`, [chunkId, processed]);
  await query(`UPDATE batches SET chunks_remaining = chunks_remaining - 1, error_count = error_count + $2 WHERE id=$1`, [batchId, errorCount]);
}

export async function chunkFailed(chunkId: string, error: string): Promise<void> {
  await query(`UPDATE batch_chunks SET status='failed', error=$2, finished_at=now() WHERE id=$1`, [chunkId, error]);
}

export async function finishBatch(batchId: string): Promise<void> {
  await query(`UPDATE batches SET status='completed', finished_at=now() WHERE id=$1`, [batchId]);
}

// ── Progress (Redis counters + live publish) ─────────────────────────────────
export async function startProgress(jobId: string, total: number, chunkCount: number): Promise<void> {
  await initProgress(jobId, total, chunkCount);
  await publishJob(jobId, { kind: 'progress', processed: 0, total, errors: 0, chunksRemaining: chunkCount, status: 'running' }).catch(() => {});
}

export async function tickProgress(
  jobId: string,
  delta: { processed?: number; errors?: number; chunksDone?: number },
): Promise<void> {
  const snap = await bumpProgress(jobId, delta);
  await publishJob(jobId, snap).catch(() => {});
}

export async function endProgress(jobId: string, status: string): Promise<void> {
  await setProgressStatus(jobId, status);
}
