import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

export const config = {
  workerId: process.env.WORKER_ID ?? `edge-${hostname()}-${randomUUID().slice(0, 8)}`,
  pool: 'edge' as const,
  version: process.env.WORKER_VERSION ?? '0.1.0',
  // Edge handlers are lightweight I/O — higher in-flight default (spec §12).
  prefetch: Number(process.env.PREFETCH ?? 8),
  heartbeatMs: Number(process.env.HEARTBEAT_MS ?? 5000),
  retryBackoffBaseMs: Number(process.env.RETRY_BACKOFF_BASE_MS ?? 2000),
  // HTTP retry policy for REST handlers.
  httpRetries: Number(process.env.HTTP_RETRIES ?? 4),
  httpBackoffBaseMs: Number(process.env.HTTP_BACKOFF_BASE_MS ?? 500),
  logLevel: process.env.LOG_LEVEL ?? 'info',
};

export function assertConfig(): void {
  for (const v of ['DATABASE_URL', 'RABBITMQ_URL', 'CONDUCTOR_MASTER_KEY']) {
    if (!process.env[v]) throw new Error(`${v} is not set`);
  }
}
