import { z } from 'zod';

// ── Cross-cutting enums & types shared by API, services, dashboard ────────────

export const RoleSchema = z.enum(['admin', 'operator', 'viewer']);
export type Role = z.infer<typeof RoleSchema>;

export const ProviderSchema = z.enum(['postgres', 'sqlserver', 'mysql']);
export type Provider = z.infer<typeof ProviderSchema>;

export const JobStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'cancelling',
  'retrying',
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** RabbitMQ routing: one capability queue per job type, plus DLQ. */
export const QUEUE_PREFIX = 'conductor';

/** Direct exchange for immediate job delivery. */
export const JOBS_EXCHANGE = `${QUEUE_PREFIX}.jobs`;
/** x-delayed-message exchange for delayed/retry delivery. */
export const DELAYED_EXCHANGE = `${QUEUE_PREFIX}.delayed`;
/** Dead-letter exchange (fanout) → DLQ. */
export const DLX_EXCHANGE = `${QUEUE_PREFIX}.dlx`;
export const DLQ_NAME = `${QUEUE_PREFIX}.dlq`;

/** Per-project isolation tier (M7). `shared` = pooled; `dedicated` = own queues + worker. */
export const IsolationModeSchema = z.enum(['shared', 'dedicated']);
export type IsolationMode = z.infer<typeof IsolationModeSchema>;

/**
 * Routing key for a job type. For a `dedicated`-tier project, pass `projectId`
 * to target its per-project routing key (`conductor.job.<type>.p.<id>`); omit it
 * (or pass null) for the `shared` pool. The relay/runner store and reuse exactly
 * the key produced here, so retries land back on the same queue.
 */
export function routingKeyForType(type: string, projectId?: string | null): string {
  const base = `${QUEUE_PREFIX}.job.${type}`;
  return projectId ? `${base}.p.${projectId}` : base;
}
/** Queue name for a job type — `dedicated` projects get `conductor.q.<type>.p.<id>`. */
export function queueForType(type: string, projectId?: string | null): string {
  const base = `${QUEUE_PREFIX}.q.${type}`;
  return projectId ? `${base}.p.${projectId}` : base;
}

/** All job types — used to declare one capability queue each. */
export const JOB_TYPES = [
  'bulk_import',
  'bulk_insert',
  'bulk_update',
  'bulk_delete',
  'file_inbound',
  'file_outbound',
  'xml_integration',
  'rest_pull',
  'rest_push',
] as const;
