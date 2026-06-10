import type { FastifyInstance } from 'fastify';
import { query } from '@conductor/db';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Liveness — process is up.
  app.get('/healthz', async () => ({ status: 'ok' }));

  // Readiness — dependencies reachable (control-plane DB).
  app.get('/readyz', async (_req, reply) => {
    try {
      await query('SELECT 1');
      return { status: 'ready' };
    } catch (err) {
      return reply.code(503).send({ status: 'not_ready', error: (err as Error).message });
    }
  });
}
