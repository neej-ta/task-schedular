import { z } from 'zod';

// ── Job envelope (spec §9). The single queue-message contract. ────────────────

export const JobTypeSchema = z.enum([
  'bulk_import',
  'bulk_insert',
  'bulk_update',
  'bulk_delete',
  'file_inbound',
  'file_outbound',
  'xml_integration',
  'rest_pull',
  'rest_push',
]);
export type JobType = z.infer<typeof JobTypeSchema>;

export const SourceSchema = z.object({
  kind: z.string(), // csv | xlsx | xml | json | project_db | sftp | s3 | rest | inline ...
  location: z.string().optional(),
  // Inline rows (source.kind === 'inline'). Modeled here so they survive the
  // envelope round-trip — a plain z.object() strips unknown keys, which silently
  // dropped them before, making the inline path unreachable via the API.
  rows: z.array(z.record(z.string(), z.unknown())).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

export const DestinationSchema = z.object({
  kind: z.string(), // project_db | s3 | sftp | rest ...
  table: z.string().optional(),
  location: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

export const JobOptionsSchema = z.object({
  chunkSize: z.number().int().positive().default(5000),
  onError: z.enum(['collect', 'fail_fast']).default('collect'),
  dryRun: z.boolean().default(false),
  hardDelete: z.boolean().default(false),
});

export const BatchRefSchema = z.object({
  batchId: z.string().uuid(),
  chunkIndex: z.number().int().nonnegative(),
  chunkCount: z.number().int().positive(),
});

export const JobEnvelopeSchema = z.object({
  jobId: z.string().uuid(),
  type: JobTypeSchema,
  projectId: z.string(),
  entity: z.string(),
  idempotencyKey: z.string(),
  source: SourceSchema,
  destination: DestinationSchema,
  ruleSetId: z.string().optional(),
  mapping: z.record(z.string(), z.string()).default({}),
  options: JobOptionsSchema.default({}),
  batch: BatchRefSchema.optional(),
  priority: z.number().int().min(0).max(9).default(5),
  attempt: z.number().int().positive().default(1),
  correlationId: z.string(),
  createdAt: z.string(), // ISO-8601
});
export type JobEnvelope = z.infer<typeof JobEnvelopeSchema>;
