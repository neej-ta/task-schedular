import type { FastifyInstance } from 'fastify';
import { query } from '@conductor/db';
import { metricsText, metricsContentType, queueDepth } from '@conductor/telemetry';
import { getQueues, replayDlq } from '../rabbit.js';
import { audit } from '../audit.js';

export async function opsRoutes(app: FastifyInstance): Promise<void> {
  const viewer = { preHandler: [app.authenticate, app.requireRole('viewer')] };
  const operator = { preHandler: [app.authenticate, app.requireRole('operator')] };

  // Prometheus scrape endpoint (unauthenticated, standard). Refreshes queue
  // depth gauges from RabbitMQ on each scrape (best-effort).
  app.get('/metrics', async (_req, reply) => {
    try {
      for (const q of await getQueues()) queueDepth.set({ queue: q.name }, q.messages);
    } catch {
      /* rabbit unreachable — still serve process/job metrics */
    }
    reply.header('Content-Type', metricsContentType());
    return metricsText();
  });

  // Workers page (spec §15): pool, version, heartbeat freshness, in-flight.
  app.get('/workers', viewer, async () => {
    const { rows } = await query(
      `SELECT id, name, pool, host, version, status, in_flight,
              last_heartbeat_at,
              EXTRACT(EPOCH FROM (now() - last_heartbeat_at))::int AS heartbeat_age_s
         FROM worker_nodes ORDER BY pool, id`,
    );
    return { workers: rows };
  });

  // Queue depths + DLQ size.
  app.get('/queues', viewer, async (_req, reply) => {
    try {
      return { queues: await getQueues() };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // DLQ replay (Operator+).
  app.post('/dlq/replay', operator, async (req, reply) => {
    const max = Math.min(Number((req.body as { max?: number })?.max ?? 100), 1000);
    try {
      const replayed = await replayDlq(max);
      await audit(req.principal, 'dlq.replay', { data: { replayed } });
      return { replayed };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // Aggregates for the Metrics page charts.
  app.get('/metrics/summary', viewer, async () => {
    const byStatus = (await query(`SELECT status, count(*)::int AS n FROM jobs GROUP BY status`)).rows;
    const byType = (await query(`SELECT type, count(*)::int AS n FROM jobs GROUP BY type ORDER BY n DESC`)).rows;
    const throughput = (
      await query(
        `SELECT to_char(date_trunc('minute', finished_at),'HH24:MI') AS minute, count(*)::int AS n
           FROM jobs WHERE status='completed' AND finished_at > now() - interval '60 minutes'
          GROUP BY 1 ORDER BY 1`,
      )
    ).rows;
    const duration = (
      await query(
        `SELECT type,
                round(avg(EXTRACT(EPOCH FROM (finished_at - started_at)))::numeric, 2) AS avg_s,
                round(percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished_at - started_at)))::numeric, 2) AS p95_s
           FROM jobs WHERE finished_at IS NOT NULL AND started_at IS NOT NULL
          GROUP BY type ORDER BY type`,
      )
    ).rows;
    return { byStatus, byType, throughput, duration };
  });
}
