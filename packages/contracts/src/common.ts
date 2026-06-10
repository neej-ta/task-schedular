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

export function routingKeyForType(type: string): string {
  return `${QUEUE_PREFIX}.job.${type}`;
}
export function queueForType(type: string): string {
  return `${QUEUE_PREFIX}.q.${type}`;
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
