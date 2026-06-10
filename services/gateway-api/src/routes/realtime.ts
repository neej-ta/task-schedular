import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { subscribeJob, subscribeActivity, getProgress } from '@conductor/realtime';
import { query } from '@conductor/db';
import type { Principal } from '../auth/plugin.js';

// ─────────────────────────────────────────────────────────────────────────────
// Server-Sent Events for live streaming (spec §14, §15). The browser's
// EventSource can't set Authorization headers, so SSE auth accepts the JWT via
// ?token=. Each connection gets its own Redis subscriber; cleaned up on close.
// ─────────────────────────────────────────────────────────────────────────────

function sseAuth(app: FastifyInstance, req: FastifyRequest): Principal | null {
  const token = (req.query as { token?: string }).token;
  if (!token) return null;
  try {
    return { ...app.jwt.verify<Principal>(token), kind: 'user' };
  } catch {
    return null;
  }
}

function openSse(req: FastifyRequest, reply: FastifyReply): (event: string, data: unknown) => void {
  reply.hijack();
  const origin = req.headers.origin ?? '*';
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': origin,
    'X-Accel-Buffering': 'no',
  });
  reply.raw.write('retry: 3000\n\n');
  return (event, data) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function realtimeRoutes(app: FastifyInstance): Promise<void> {
  // Per-job stream: logs + progress + state transitions.
  app.get('/jobs/:id/stream', async (req, reply) => {
    if (!sseAuth(app, req)) return reply.code(401).send({ error: 'unauthorized' });
    const { id } = req.params as { id: string };
    const send = openSse(req, reply);

    // Send the current progress snapshot immediately so the bar is correct on load.
    try {
      send('progress', await getProgress(id));
    } catch {
      /* no progress yet */
    }

    const unsub = subscribeJob(id, (m) => send(m.kind, m));
    const hb = setInterval(() => reply.raw.write(': hb\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(hb);
      unsub();
    });
  });

  // Activity history (the feed seeds from this, then streams live).
  app.get('/activity', { preHandler: [app.authenticate, app.requireRole('viewer')] }, async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 100), 500);
    const { rows } = await query(
      `SELECT ts, type, job_id AS "jobId", project_id AS "projectId", actor, message
         FROM job_events ORDER BY ts DESC, id DESC LIMIT $1`,
      [limit],
    );
    return { activity: rows };
  });

  // Global activity feed.
  app.get('/activity/stream', async (req, reply) => {
    if (!sseAuth(app, req)) return reply.code(401).send({ error: 'unauthorized' });
    const send = openSse(req, reply);
    const unsub = subscribeActivity((e) => send('activity', e));
    const hb = setInterval(() => reply.raw.write(': hb\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(hb);
      unsub();
    });
  });
}
