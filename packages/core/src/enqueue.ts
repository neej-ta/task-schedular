import { randomUUID } from 'node:crypto';
import { withTransaction } from '@conductor/db';
import {
  routingKeyForType,
  type JobEnvelope,
  type JobType,
} from '@conductor/contracts';

export interface EnqueueInput {
  projectId: string;
  entity: string;
  type: JobType;
  /** When set, a UNIQUE index guarantees the job is enqueued at most once. */
  idempotencyKey?: string | null;
  source?: Record<string, unknown>;
  destination?: Record<string, unknown>;
  ruleSetId?: string | null;
  mapping?: Record<string, string>;
  options?: Record<string, unknown>;
  priority?: number;
  definitionId?: string | null;
  parameters?: Record<string, unknown>;
  correlationId?: string;
}

export interface EnqueueResult {
  enqueued: boolean; // false when an idempotency-key conflict skipped it
  jobId: string | null;
}

/**
 * Transactional enqueue (spec §5.2). Inserts the `jobs` row AND the `outbox`
 * row in ONE transaction. A separate relay publishes the outbox row to RabbitMQ
 * with publisher confirms. Never publishes inline.
 *
 * Idempotency: if `idempotencyKey` collides with an existing job, nothing is
 * inserted and `enqueued: false` is returned — this is what prevents a clustered
 * scheduler from double-firing the same scheduled run.
 */
export async function enqueueJob(input: EnqueueInput): Promise<EnqueueResult> {
  const jobId = randomUUID();
  const correlationId = input.correlationId ?? jobId;
  const source = input.source ?? {};
  const destination = input.destination ?? {};
  const options = input.options ?? {};
  const mapping = input.mapping ?? {};
  const priority = input.priority ?? 5;
  const routingKey = routingKeyForType(input.type);

  return withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO jobs
         (id, definition_id, project_id, entity, type, status, idempotency_key,
          parameters_jsonb, source_jsonb, destination_jsonb, rule_set_id, priority)
       VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$8,$9,$10,$11)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        jobId,
        input.definitionId ?? null,
        input.projectId,
        input.entity,
        input.type,
        input.idempotencyKey ?? null,
        // Persist options (+ mapping) on the job row so they survive retry &
        // inspection — the queue payload alone is ephemeral (spec §15 H10/H11).
        JSON.stringify({ ...(input.parameters ?? {}), options, mapping }),
        JSON.stringify(source),
        JSON.stringify(destination),
        input.ruleSetId ?? null,
        priority,
      ],
    );

    if (inserted.rowCount === 0) {
      // Idempotency-key conflict — already enqueued. No-op (no double-fire).
      return { enqueued: false, jobId: null };
    }

    const envelope: JobEnvelope = {
      jobId,
      type: input.type,
      projectId: input.projectId,
      entity: input.entity,
      idempotencyKey: input.idempotencyKey ?? jobId,
      source: { kind: (source.kind as string) ?? 'unknown', ...source },
      destination: { kind: (destination.kind as string) ?? 'unknown', ...destination },
      ruleSetId: input.ruleSetId ?? undefined,
      mapping,
      options: {
        chunkSize: (options.chunkSize as number) ?? 5000,
        onError: (options.onError as 'collect' | 'fail_fast') ?? 'collect',
        dryRun: (options.dryRun as boolean) ?? false,
        hardDelete: (options.hardDelete as boolean) ?? false,
      },
      priority,
      attempt: 1,
      correlationId,
      createdAt: new Date().toISOString(),
    };

    await client.query(
      `INSERT INTO outbox (aggregate_id, routing_key, payload_jsonb, status)
       VALUES ($1, $2, $3, 'pending')`,
      [jobId, routingKey, JSON.stringify(envelope)],
    );

    await client.query(
      `INSERT INTO job_events (job_id, project_id, type, actor, message)
       VALUES ($1, $2, 'job.queued', $3, $4)`,
      [jobId, input.projectId, input.definitionId ? 'scheduler' : 'api', `queued ${input.type}`],
    );

    return { enqueued: true, jobId };
  });
}
