import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

// Prometheus metrics (spec §16). One registry per process; exposed at /metrics.
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'conductor_' });

export const jobsTotal = new Counter({
  name: 'conductor_jobs_total',
  help: 'Jobs by type and terminal status',
  labelNames: ['type', 'status'],
  registers: [registry],
});

export const jobDurationSeconds = new Histogram({
  name: 'conductor_job_duration_seconds',
  help: 'Job execution duration in seconds',
  labelNames: ['type'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [registry],
});

export const rowsProcessedTotal = new Counter({
  name: 'conductor_rows_processed_total',
  help: 'Rows processed (staged/updated/deleted)',
  labelNames: ['type'],
  registers: [registry],
});

export const chunkRetriesTotal = new Counter({
  name: 'conductor_chunk_retries_total',
  help: 'Chunk/job retry attempts',
  registers: [registry],
});

export const workerInFlight = new Gauge({
  name: 'conductor_worker_in_flight',
  help: 'In-flight units per worker',
  labelNames: ['worker', 'pool'],
  registers: [registry],
});

export const dbConnectionErrorsTotal = new Counter({
  name: 'conductor_db_connection_errors_total',
  help: 'Target DB connection errors',
  registers: [registry],
});

export const queueDepth = new Gauge({
  name: 'conductor_queue_depth',
  help: 'Messages ready in a capability queue',
  labelNames: ['queue'],
  registers: [registry],
});

export async function metricsText(): Promise<string> {
  return registry.metrics();
}
export function metricsContentType(): string {
  return registry.contentType;
}
