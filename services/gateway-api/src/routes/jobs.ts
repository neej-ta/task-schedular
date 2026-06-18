import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { JobTypeSchema } from '@conductor/contracts';
import { enqueueJob } from '@conductor/core';
import { query } from '@conductor/db';
import { getProgress, requestCancel, publishActivity } from '@conductor/realtime';
import { getObjectText, getObjectStream, defaultBucket } from '@conductor/storage';
import { listJobs, getJob } from '../repos/jobs.js';
import { audit } from '../audit.js';

const AdHocBody = z.object({
  projectId: z.string().uuid(),
  entity: z.string().min(1),
  type: JobTypeSchema,
  idempotencyKey: z.string().optional(),
  source: z.record(z.string(), z.unknown()).optional(),
  destination: z.record(z.string(), z.unknown()).optional(),
  ruleSetId: z.string().optional(),
  mapping: z.record(z.string(), z.string()).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  priority: z.number().int().min(0).max(9).optional(),
});

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  const viewer = { preHandler: [app.authenticate, app.requireRole('viewer')] };
  const operator = { preHandler: [app.authenticate, app.requireRole('operator')] };

  // Ad-hoc enqueue (job + outbox in one tx). Returns in ms — never blocks.
  app.post('/jobs', operator, async (req, reply) => {
    const parsed = AdHocBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.flatten() });
    }
    const b = parsed.data;
    const res = await enqueueJob({
      projectId: b.projectId,
      entity: b.entity,
      type: b.type,
      idempotencyKey: b.idempotencyKey,
      source: b.source,
      destination: b.destination,
      ruleSetId: b.ruleSetId,
      mapping: b.mapping,
      options: b.options,
      priority: b.priority,
    });
    await audit(req.principal, 'job.create', { jobId: res.jobId ?? undefined, projectId: b.projectId });
    if (res.jobId) {
      await publishActivity({ ts: new Date().toISOString(), type: 'job.queued', jobId: res.jobId, projectId: b.projectId, actor: req.principal?.email, message: `queued ${b.type}` }).catch(() => {});
    }
    return reply.code(202).send({ enqueued: res.enqueued, jobId: res.jobId });
  });

  app.get('/jobs', viewer, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const toInt = (v: string | undefined, def: number) => {
      const n = Math.trunc(Number(v));
      return Number.isFinite(n) ? n : def;
    };
    const limit = Math.min(Math.max(toInt(q.limit, 50), 1), 200);
    const offset = Math.max(toInt(q.offset, 0), 0);
    const result = await listJobs({
      status: q.status, projectId: q.project, type: q.type,
      from: q.from, to: q.to, q: q.q, limit, offset,
    });
    return { ...result, limit, offset };
  });

  app.get('/jobs/:id', viewer, async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = await getJob(id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    return { job };
  });

  // Paginated log tail (history). Live appends arrive via SSE /jobs/:id/stream.
  app.get('/jobs/:id/logs', viewer, async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { after?: string; limit?: string };
    const after = Number(q.after ?? 0);
    const limit = Math.min(Number(q.limit ?? 500), 2000);
    const { rows } = await query(
      `SELECT id, ts, level, message, chunk_index FROM job_logs
        WHERE job_id=$1 AND id > $2 ORDER BY id ASC LIMIT $3`,
      [id, after, limit],
    );
    return { logs: rows };
  });

  app.get('/jobs/:id/errors', viewer, async (req) => {
    const { id } = req.params as { id: string };
    // `raw` is the original source row, so the dashboard can show the offending
    // value next to each rejection.
    const { rows } = await query(
      `SELECT row_number, field, rule, message, raw_jsonb AS raw FROM job_errors WHERE job_id=$1 ORDER BY row_number LIMIT 5000`,
      [id],
    );
    return { errors: rows };
  });

  // Download the WHOLE import file annotated with per-row _status (OK/REJECTED)
  // and _reason — written by the worker when an import has rejected rows. The
  // user fixes the rejected rows and re-imports the file (already-imported rows
  // are skipped idempotently). Served via the gateway so auth/RBAC apply.
  app.get('/jobs/:id/rejects.csv', viewer, async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = await getJob(id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    try {
      const csv = await getObjectText(defaultBucket(), `rejects/${id}.csv`);
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="task-${id.slice(0, 8)}-rows.csv"`);
      return csv;
    } catch {
      return reply.code(404).send({ error: 'no rejected-rows file for this job (it had no rejected rows)' });
    }
  });

  // Same annotated file as an Excel workbook with the offending cells highlighted
  // red (+ _status/_reason columns) — written by the worker when an import has
  // rejected rows. Streamed as a binary download; auth/RBAC apply via the gateway.
  app.get('/jobs/:id/rejects.xlsx', viewer, async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = await getJob(id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    try {
      const stream = await getObjectStream(defaultBucket(), `rejects/${id}.xlsx`);
      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('Content-Disposition', `attachment; filename="task-${id.slice(0, 8)}-rows.xlsx"`);
      return reply.send(stream);
    } catch {
      return reply.code(404).send({ error: 'no rejected-rows file for this job (it had no rejected rows)' });
    }
  });

  app.get('/jobs/:id/chunks', viewer, async (req) => {
    const { id } = req.params as { id: string };
    const { rows } = await query(
      `SELECT bc.chunk_index, bc.status, bc.processed_count, bc.row_start, bc.row_end
         FROM batch_chunks bc JOIN batches b ON b.id=bc.batch_id
        WHERE b.job_id=$1 ORDER BY bc.chunk_index`,
      [id],
    );
    return { chunks: rows };
  });

  app.get('/jobs/:id/events', viewer, async (req) => {
    const { id } = req.params as { id: string };
    const { rows } = await query(
      `SELECT ts, type, actor, message FROM job_events WHERE job_id=$1 ORDER BY ts ASC, id ASC`,
      [id],
    );
    return { events: rows };
  });

  app.get('/jobs/:id/progress', viewer, async (req) => {
    const { id } = req.params as { id: string };
    return { progress: await getProgress(id) };
  });

  // Cancel (spec §13): running → cancelling (worker stops at next chunk boundary);
  // queued/retrying → cancelled directly (the message is skipped on delivery).
  app.post('/jobs/:id/cancel', operator, async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = await getJob(id);
    if (!job) return reply.code(404).send({ error: 'not found' });

    // Set the cancel flag FIRST so a worker that claims the job concurrently
    // still observes it at the next chunk boundary (closes the check-then-act
    // race with claimJob). Then transition status with ATOMIC conditional
    // UPDATEs that can never clobber a concurrent queued→running claim.
    await requestCancel(id);
    const queued = await query(
      `UPDATE jobs SET status='cancelled', finished_at=now() WHERE id=$1 AND status IN ('queued','retrying')`,
      [id],
    );
    if ((queued.rowCount ?? 0) === 0) {
      const running = await query(`UPDATE jobs SET status='cancelling' WHERE id=$1 AND status='running'`, [id]);
      if ((running.rowCount ?? 0) === 0) {
        const cur = await getJob(id);
        return reply.code(409).send({ error: `cannot cancel a ${cur?.status} job` });
      }
    }
    await query(`INSERT INTO job_events(job_id, project_id, type, actor, message) VALUES ($1,$2,'job.cancelling',$3,'cancel requested')`, [id, job.project_id, req.principal?.email ?? 'api']);
    await publishActivity({ ts: new Date().toISOString(), type: 'job.cancelling', jobId: id, projectId: job.project_id, actor: req.principal?.email, message: 'cancel requested' }).catch(() => {});
    await audit(req.principal, 'job.cancel', { jobId: id, projectId: job.project_id });
    return { ok: true };
  });

  // Retry: enqueue a NEW job cloned from this one (spec §14). Only terminal jobs
  // may be retried — retrying a queued/running job would double-run it.
  app.post('/jobs/:id/retry', operator, async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = await getJob(id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    if (!['failed', 'cancelled', 'completed'].includes(job.status)) {
      return reply.code(409).send({ error: `cannot retry a ${job.status} job (only failed/cancelled/completed)` });
    }

    // Clone options/ruleSetId/priority faithfully from the persisted job row.
    const params = job.parameters_jsonb ?? {};
    const res = await enqueueJob({
      projectId: job.project_id,
      entity: job.entity,
      type: job.type as never,
      idempotencyKey: `retry:${id}:${Date.now()}`,
      source: job.source_jsonb,
      destination: job.destination_jsonb,
      ruleSetId: job.rule_set_id ?? undefined,
      priority: job.priority,
      options: (params.options as Record<string, unknown>) ?? undefined,
      mapping: (params.mapping as Record<string, string>) ?? undefined,
      parameters: params,
    });
    await audit(req.principal, 'job.retry', { jobId: res.jobId ?? undefined, projectId: job.project_id, data: { from: id } });
    if (res.jobId) {
      await publishActivity({ ts: new Date().toISOString(), type: 'job.queued', jobId: res.jobId, projectId: job.project_id, actor: req.principal?.email, message: `retry of ${id.slice(0, 8)}` }).catch(() => {});
    }
    return reply.code(202).send({ enqueued: res.enqueued, jobId: res.jobId });
  });
}
