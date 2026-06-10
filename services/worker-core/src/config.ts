import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

export const config = {
  workerId: process.env.WORKER_ID ?? `core-${hostname()}-${randomUUID().slice(0, 8)}`,
  pool: 'core' as const,
  version: process.env.WORKER_VERSION ?? '0.1.0',
  // In-flight jobs/chunks per worker (spec §12: core default 2).
  prefetch: Number(process.env.PREFETCH ?? 2),
  // Within a single bulk job, how many chunks to process concurrently.
  chunkConcurrency: Number(process.env.CHUNK_CONCURRENCY ?? 4),
  heartbeatMs: Number(process.env.HEARTBEAT_MS ?? 5000),
  // Retry backoff base (ms) — exponential per attempt via the delayed exchange.
  retryBackoffBaseMs: Number(process.env.RETRY_BACKOFF_BASE_MS ?? 2000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
};

export function assertConfig(): void {
  for (const v of ['DATABASE_URL', 'RABBITMQ_URL', 'CONDUCTOR_MASTER_KEY']) {
    if (!process.env[v]) throw new Error(`${v} is not set`);
  }
}
