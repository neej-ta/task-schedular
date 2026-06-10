import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { migrate, closePool } from '@conductor/db';
import { config, assertConfig } from './config.js';
import { registerAuth } from './auth/plugin.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { jobDefinitionRoutes } from './routes/jobDefinitions.js';
import { jobRoutes } from './routes/jobs.js';
import { realtimeRoutes } from './routes/realtime.js';
import { opsRoutes } from './routes/ops.js';
import { uploadRoutes } from './routes/uploads.js';
import { entityRoutes } from './routes/entities.js';
import { startTracing, stopTracing } from '@conductor/telemetry';
import { seed } from './seed.js';

async function buildServer() {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Defensive redaction — secrets must never reach the logs (spec §17).
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-api-key"]',
          'req.body.secret',
          'req.body.password',
          '*.secret',
          '*.password',
          '*.secret_ciphertext',
        ],
        censor: '[redacted]',
      },
      serializers: {
        // SSE endpoints carry the JWT in ?token= (EventSource can't set headers);
        // strip it from the logged URL so the token never lands in logs (spec §17).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        req(req: any) {
          return {
            method: req.method,
            url: String(req.url).replace(/([?&]token=)[^&]*/i, '$1[redacted]'),
            host: req.headers?.host,
          };
        },
      },
      transport:
        process.env.NODE_ENV === 'production'
          ? undefined
          : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
    },
  });

  await app.register(cors, {
    origin: config.corsOrigin.split(',').map((s) => s.trim()),
    credentials: true,
  });

  // Multipart for CSV/Excel uploads (50 MB cap, single file per request).
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1 } });

  await registerAuth(app);
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(projectRoutes);
  await app.register(jobDefinitionRoutes);
  await app.register(jobRoutes);
  await app.register(realtimeRoutes);
  await app.register(opsRoutes);
  await app.register(uploadRoutes);
  await app.register(entityRoutes);

  // Serve the pre-built dashboard SPA same-origin (container only). The
  // dashboard uses in-memory (state) navigation — no URL routes — and all API
  // routes above are specific paths, so the static wildcard never shadows them.
  if (process.env.SERVE_DASHBOARD === 'true') {
    const distDir =
      process.env.DASHBOARD_DIST ?? fileURLToPath(new URL('../../../dashboard/dist', import.meta.url));
    if (existsSync(distDir)) {
      const fastifyStatic = (await import('@fastify/static')).default;
      await app.register(fastifyStatic, { root: distDir, prefix: '/' });
      app.log.info({ distDir }, 'serving dashboard SPA');
    } else {
      app.log.warn({ distDir }, 'SERVE_DASHBOARD=true but dashboard build not found; skipping');
    }
  }

  return app;
}

async function main() {
  assertConfig();
  await startTracing('gateway-api');

  // Apply control-plane migrations on boot (idempotent). Simplifies local dev;
  // in prod this would be a separate migration job (see docs/RUNBOOK.md).
  if (process.env.AUTO_MIGRATE !== 'false') {
    await migrate();
  }

  const app = await buildServer();

  // Optional dev seed on boot (idempotent). Off by default; on in compose.
  if (process.env.SEED_ON_BOOT === 'true') {
    try {
      await seed((m) => app.log.info(m));
    } catch (err) {
      app.log.error(err, 'seed failed');
    }
  }

  await app.listen({ port: config.port, host: config.host });

  // Graceful shutdown (spec §5.8 / §23) — stop accepting, drain, close pool.
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await closePool();
      await stopTracing();
      process.exit(0);
    } catch (err) {
      app.log.error(err, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('failed to start gateway-api', err);
  process.exit(1);
});
