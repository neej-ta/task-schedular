import type { Channel, ConfirmChannel, ConsumeMessage } from 'amqplib';
import { getConnection, createConfirmChannel, publishWithConfirm } from '@conductor/messaging';
import { JobEnvelopeSchema, queueForType, routingKeyForType } from '@conductor/contracts';
import { query } from '@conductor/db';
import { acquireProjectSlot, releaseProjectSlot } from '@conductor/realtime';
import { jobsTotal, jobDurationSeconds, rowsProcessedTotal, chunkRetriesTotal, workerInFlight } from '@conductor/telemetry';
import { resolveContext, type JobContext } from './context.js';
import * as report from './reporter.js';

/** Thrown by a handler to signal cooperative cancellation (terminal, no retry). */
export class JobCancelled extends Error {
  constructor() {
    super('job cancelled');
    this.name = 'JobCancelled';
  }
}

export type Handler = (ctx: JobContext) => Promise<void>;

export interface RunnerConfig {
  workerId: string;
  pool: 'core' | 'edge';
  version: string;
  prefetch: number;
  retryBackoffBaseMs: number;
  heartbeatMs: number;
  handlers: Record<string, Handler>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /**
   * Isolation tier this worker serves (M7). `shared` (default) drains the pooled
   * `conductor.q.<type>` queues and enforces the per-project Redis semaphore.
   * `project` is a dedicated worker bound to ONE project's per-project queues
   * (`conductor.q.<type>.p.<projectId>`); it skips the semaphore (the dedicated
   * container is itself the isolation) and routes retries back to those queues.
   */
  mode?: 'shared' | 'project';
  /** Required when `mode === 'project'`: the project this worker is dedicated to. */
  projectId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic worker shell (spec §5.3, §5.7, §5.8, §13). A thin runtime + a registry
// of pluggable handlers keyed by job type. Used by BOTH worker-core and
// worker-edge — adding a job type = registering a handler, the shell never
// changes. Manual ack-after-durable, retry-with-backoff→DLQ, heartbeat,
// graceful drain.
// ─────────────────────────────────────────────────────────────────────────────

export class Runner {
  private channel: Channel | null = null;
  private retryChannel: ConfirmChannel | null = null;
  private consumerTags: string[] = [];
  private inFlight = 0;
  private draining = false;
  private heartbeat: NodeJS.Timeout | null = null;
  private limitCache = new Map<string, { limit: number; at: number }>();

  constructor(private readonly cfg: RunnerConfig) {}

  /** The project to scope queues/routing to, or undefined for the shared pool. */
  private routeProjectId(): string | undefined {
    return this.cfg.mode === 'project' ? this.cfg.projectId : undefined;
  }

  /** Per-project concurrency limit, cached briefly to avoid a query per message. */
  private async projectLimit(projectId: string): Promise<number> {
    const cached = this.limitCache.get(projectId);
    if (cached && Date.now() - cached.at < 30_000) return cached.limit;
    const { rows } = await query<{ concurrency_limit: number }>(
      'SELECT concurrency_limit FROM projects WHERE id=$1',
      [projectId],
    );
    const limit = rows[0]?.concurrency_limit ?? 4;
    this.limitCache.set(projectId, { limit, at: Date.now() });
    return limit;
  }

  private log(msg: string, extra?: Record<string, unknown>): void {
    this.cfg.log(msg, extra);
  }

  async start(): Promise<void> {
    await this.register();
    this.heartbeat = setInterval(() => void this.beat(), this.cfg.heartbeatMs);

    const conn = await getConnection();
    this.channel = await conn.createChannel();
    this.retryChannel = await createConfirmChannel();
    await this.channel.prefetch(this.cfg.prefetch);

    for (const type of Object.keys(this.cfg.handlers)) {
      const queue = queueForType(type, this.routeProjectId());
      const { consumerTag } = await this.channel.consume(queue, (msg) => {
        if (!msg) return;
        this.onMessage(msg).catch((err) => {
          this.log(`onMessage crashed: ${(err as Error).message}; requeuing`);
          try {
            this.channel?.nack(msg, false, true);
          } catch {
            /* channel gone */
          }
        });
      });
      this.consumerTags.push(consumerTag);
      this.log(`consuming ${queue} (prefetch ${this.cfg.prefetch})`);
    }
  }

  private async onMessage(msg: ConsumeMessage): Promise<void> {
    const ch = this.channel!;
    if (this.draining) {
      ch.nack(msg, false, true); // refuse new work; another worker takes it
      return;
    }

    this.inFlight++;
    let envelope;
    try {
      envelope = JobEnvelopeSchema.parse(JSON.parse(msg.content.toString()));
    } catch (err) {
      this.log(`bad envelope, dead-lettering: ${(err as Error).message}`);
      ch.nack(msg, false, false);
      this.inFlight--;
      return;
    }

    const handler = this.cfg.handlers[envelope.type];
    if (!handler) {
      this.log(`no handler for type ${envelope.type}, dead-lettering`);
      ch.nack(msg, false, false);
      this.inFlight--;
      return;
    }

    // Per-project concurrency limit (spec §12). If the project is at its cap,
    // DEFER the job (re-publish with a short delay) instead of running it — this
    // protects the project's DB and gives fair throughput across projects.
    // Dedicated (project-mode) workers skip the semaphore: the container is a
    // single project's exclusive runtime, so its own prefetch is the limit.
    let acquired = false;
    if (this.cfg.mode !== 'project') try {
      const limit = await this.projectLimit(envelope.projectId);
      acquired = await acquireProjectSlot(envelope.projectId, limit);
      if (!acquired) {
        const delayMs = 1000 + Math.floor(Math.random() * 1500);
        try {
          await publishWithConfirm(this.retryChannel!, routingKeyForType(envelope.type, this.routeProjectId()), envelope, {
            delayMs,
            priority: Number(envelope.priority ?? 5),
            correlationId: String(envelope.correlationId ?? envelope.jobId),
            messageId: envelope.jobId,
          });
          ch.ack(msg);
          this.log(`job ${envelope.jobId} deferred — project ${envelope.projectId} at limit ${limit}`);
        } catch {
          ch.nack(msg, false, true);
        }
        this.inFlight--;
        return;
      }
    } catch (err) {
      // If the gate itself errors, fall through and let the job run (fail-open
      // on the limiter is safer than dropping work).
      this.log(`concurrency gate error for ${envelope.jobId}: ${(err as Error).message}`);
    }

    try {
      const claimed = await report.claimJob(envelope.jobId, this.cfg.workerId);
      if (!claimed) {
        const status = await report.jobStatus(envelope.jobId);
        this.log(`job ${envelope.jobId} not claimable (status=${status}); acking`);
        ch.ack(msg);
        return;
      }
      const started = Date.now();
      const ctx = await resolveContext(envelope);
      await handler(ctx);
      ch.ack(msg); // ack ONLY after the unit is durable (spec §13)
      await this.recordTerminal(envelope.jobId, envelope.type, started);
    } catch (err) {
      if (err instanceof JobCancelled) {
        await query(`UPDATE jobs SET status='cancelled', finished_at=now() WHERE id=$1`, [envelope.jobId]);
        await report.event('job.cancelled', 'cancelled at chunk boundary', { jobId: envelope.jobId });
        jobsTotal.inc({ type: envelope.type, status: 'cancelled' });
        ch.ack(msg);
      } else {
        await this.handleFailure(msg, envelope.jobId, envelope.type, envelope, (err as Error).message);
      }
    } finally {
      if (acquired) await releaseProjectSlot(envelope.projectId).catch(() => {});
      this.inFlight--;
    }
  }

  /** Record completion metrics (jobsTotal + duration + rows) using the final status. */
  private async recordTerminal(jobId: string, type: string, startedMs: number): Promise<void> {
    try {
      const status = (await report.jobStatus(jobId)) ?? 'completed';
      jobsTotal.inc({ type, status });
      jobDurationSeconds.observe({ type }, (Date.now() - startedMs) / 1000);
      const { rows } = await query<{ n: number }>(
        `SELECT COALESCE(SUM(bc.processed_count),0)::int AS n
           FROM batch_chunks bc JOIN batches b ON b.id=bc.batch_id WHERE b.job_id=$1`,
        [jobId],
      );
      const n = rows[0]?.n ?? 0;
      if (n > 0) rowsProcessedTotal.inc({ type }, n);
    } catch {
      /* metrics are best-effort */
    }
  }

  private async handleFailure(
    msg: ConsumeMessage,
    jobId: string,
    type: string,
    envelope: Record<string, unknown>,
    error: string,
  ): Promise<void> {
    const ch = this.channel!;
    const attempt = Number(envelope.attempt ?? 1);
    const { rows } = await query<{ max_attempts: number }>('SELECT max_attempts FROM jobs WHERE id=$1', [jobId]);
    const maxAttempts = rows[0]?.max_attempts ?? 5;

    await report.log(jobId, 'error', `attempt ${attempt} failed: ${error}`);

    if (attempt < maxAttempts) {
      // Make the delayed copy DURABLE first, then mutate status + ack original.
      const delayMs = this.cfg.retryBackoffBaseMs * 2 ** (attempt - 1);
      const next = { ...envelope, attempt: attempt + 1 };
      try {
        await publishWithConfirm(this.retryChannel!, routingKeyForType(type, this.routeProjectId()), next, {
          delayMs,
          priority: Number(envelope.priority ?? 5),
          correlationId: String(envelope.correlationId ?? jobId),
          messageId: jobId,
        });
      } catch (pubErr) {
        this.log(`failed to schedule retry for ${jobId}: ${(pubErr as Error).message}; requeuing original`);
        ch.nack(msg, false, true);
        return;
      }
      await report.retryingJob(jobId, attempt + 1);
      await report.event('job.retrying', `retry ${attempt + 1}/${maxAttempts} in ${delayMs}ms`, { jobId });
      chunkRetriesTotal.inc();
      ch.ack(msg);
      this.log(`job ${jobId} scheduled retry ${attempt + 1} in ${delayMs}ms`);
    } else {
      await report.failJob(jobId, error);
      await report.event('job.failed', `failed after ${attempt} attempts: ${error}`, { jobId });
      jobsTotal.inc({ type, status: 'failed' });
      ch.nack(msg, false, false); // exhausted → DLQ
      this.log(`job ${jobId} exhausted retries → DLQ`);
    }
  }

  private async register(): Promise<void> {
    await query(
      `INSERT INTO worker_nodes (id, name, pool, host, version, status, capabilities_jsonb)
       VALUES ($1,$1,$2,$3,$4,'online',$5)
       ON CONFLICT (id) DO UPDATE SET status='online', last_heartbeat_at=now(), version=$4`,
      [this.cfg.workerId, this.cfg.pool, process.env.HOSTNAME ?? 'local', this.cfg.version, JSON.stringify(Object.keys(this.cfg.handlers))],
    );
    this.log(`registered worker ${this.cfg.workerId}`);
  }

  private async beat(): Promise<void> {
    workerInFlight.set({ worker: this.cfg.workerId, pool: this.cfg.pool }, this.inFlight);
    await query(`UPDATE worker_nodes SET last_heartbeat_at=now(), in_flight=$2, status='online' WHERE id=$1`, [
      this.cfg.workerId,
      this.inFlight,
    ]).catch(() => {});
  }

  async shutdown(): Promise<void> {
    this.draining = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.channel) {
      for (const tag of this.consumerTags) await this.channel.cancel(tag).catch(() => {});
    }
    const deadline = Date.now() + 30_000;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    await query(`UPDATE worker_nodes SET status='offline' WHERE id=$1`, [this.cfg.workerId]).catch(() => {});
    if (this.channel) await this.channel.close().catch(() => {});
    if (this.retryChannel) await this.retryChannel.close().catch(() => {});
    this.log(`drained; ${this.inFlight} still in-flight at deadline`);
  }
}
