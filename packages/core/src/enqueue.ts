import { randomUUID } from 'node:crypto';
import { query, withTransaction, assertSchemaName } from '@conductor/db';
import {
  routingKeyForType,
  type IsolationMode,
  type JobEnvelope,
  type JobType,
} from '@conductor/contracts';

// Per-project isolation tier (+ execution schema), cached briefly to avoid a
// query per enqueue (the scheduler may fire many in a tick). The provisioner
// flips this rarely, so a short TTL is safe; a stale 'shared' read at worst
// routes one job to the shared pool during the promotion window.
// M7 / DESIGN-isolation-tiers.md.
interface Isolation {
  mode: IsolationMode;
  schema: string | null;
}
const isolationCache = new Map<string, { value: Isolation; at: number }>();
const ISOLATION_TTL_MS = 30_000;

async function projectIsolation(projectId: string): Promise<Isolation> {
  const cached = isolationCache.get(projectId);
  if (cached && Date.now() - cached.at < ISOLATION_TTL_MS) return cached.value;
  const { rows } = await query<{ isolation_mode: IsolationMode; db_schema: string | null }>(
    'SELECT isolation_mode, db_schema FROM projects WHERE id=$1',
    [projectId],
  );
  const value: Isolation = {
    mode: rows[0]?.isolation_mode ?? 'shared',
    schema: rows[0]?.db_schema ?? null,
  };
  isolationCache.set(projectId, { value, at: Date.now() });
  return value;
}

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
  // Dedicated-tier projects route to their own per-project queue; shared-tier
  // projects use the pooled queue (today's behavior). The chosen key is stored
  // in the outbox row, so the relay publishes — and retries re-publish — to the
  // same queue regardless of which worker handles it.
  const isolation = await projectIsolation(input.projectId);
  const dedicated = isolation.mode === 'dedicated';
  const routingKey = routingKeyForType(input.type, dedicated ? input.projectId : undefined);
  // Dedicated jobs' execution rows live in the project's schema; only the outbox
  // stays in `public`. Setting search_path for THIS transaction sends the jobs +
  // job_events inserts to the project schema while outbox falls through to
  // public — one transaction, one database (preserves the transactional outbox).
  const useSchema = dedicated && isolation.schema ? isolation.schema : null;
  if (useSchema) assertSchemaName(useSchema);

  return withTransaction(async (client) => {
    if (useSchema) {
      await client.query(`SET LOCAL search_path TO ${useSchema}, public`);
    }
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
