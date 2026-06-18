import { getConnection, assertTopology, assertProjectTopology, createConfirmChannel, closeConnection } from '@conductor/messaging';
import { closePool, query } from '@conductor/db';
import { closeAllTargetPools } from '@conductor/targetdb';
import { Runner } from '@conductor/worker-runtime';
import { startMetricsServer, startTracing, stopTracing } from '@conductor/telemetry';
import { config, assertConfig } from './config.js';
import { handlers } from './handlers/registry.js';

const log = (msg: string, extra?: Record<string, unknown>) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), svc: 'worker-core', worker: config.workerId, msg, ...extra }));

async function waitForSchema(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      await query('SELECT 1 FROM worker_nodes LIMIT 1');
      return;
    } catch {
      if (i === 0) log('waiting for control-plane schema…');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('control-plane schema not ready after 120s');
}

async function main() {
  assertConfig();
  log(`starting worker-core ${config.workerId}`);
  await startTracing('worker-core');
  startMetricsServer(Number(process.env.METRICS_PORT ?? 9101), (m) => log(m));
  await waitForSchema();

  await getConnection();
  const setup = await createConfirmChannel();
  await assertTopology(setup);
  // Dedicated worker: also declare this project's per-project queues before consuming.
  if (config.mode === 'project') {
    await assertProjectTopology(setup, config.projectId!);
    log(`dedicated worker for project ${config.projectId}`);
  }
  await setup.close();

  const runner = new Runner({
    workerId: config.workerId,
    pool: 'core',
    version: config.version,
    prefetch: config.prefetch,
    retryBackoffBaseMs: config.retryBackoffBaseMs,
    heartbeatMs: config.heartbeatMs,
    handlers,
    log,
    mode: config.mode,
    projectId: config.projectId,
  });
  await runner.start();
  log('worker ready');

  const shutdown = async (signal: string) => {
    log(`received ${signal}, draining`);
    await runner.shutdown();
    await closeAllTargetPools();
    await closeConnection();
    await closePool();
    await stopTracing();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('worker-core failed to start', err);
  process.exit(1);
});
