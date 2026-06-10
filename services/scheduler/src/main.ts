import { getConnection, assertTopology, closeConnection, createConfirmChannel } from '@conductor/messaging';
import { closePool } from '@conductor/db';
import { config, assertConfig } from './config.js';
import { LeaderElector } from './leader.js';
import { OutboxRelay } from './relay.js';
import { evaluateSchedules } from './scheduler.js';

const log = (msg: string) => console.log(JSON.stringify({ ts: new Date().toISOString(), svc: 'scheduler', instance: config.instanceId, msg }));

let running = true;

async function main() {
  assertConfig();
  log(`starting scheduler instance ${config.instanceId}`);

  // Assert the RabbitMQ topology once on boot (idempotent).
  await getConnection();
  const setupCh = await createConfirmChannel();
  await assertTopology(setupCh);
  await setupCh.close();
  log('topology asserted');

  const leader = new LeaderElector(log);
  const relay = new OutboxRelay(log);

  // Outbox relay loop — every instance.
  const relayLoop = async () => {
    while (running) {
      try {
        await relay.tick();
      } catch (err) {
        log(`[relay] tick error: ${(err as Error).message}`);
      }
      await sleep(config.relayTickMs);
    }
  };

  // Scheduler loop — leader only fires schedules.
  const schedulerLoop = async () => {
    while (running) {
      try {
        await leader.tick();
        if (leader.isLeader()) {
          await evaluateSchedules(log);
        }
      } catch (err) {
        log(`[scheduler] tick error: ${(err as Error).message}`);
      }
      await sleep(config.schedulerTickMs);
    }
  };

  void relayLoop();
  void schedulerLoop();

  // Graceful shutdown (spec §5.8): stop loops, release leadership, close conns.
  const shutdown = async (signal: string) => {
    log(`received ${signal}, shutting down`);
    running = false;
    await leader.release();
    await relay.close();
    await closeConnection();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('scheduler failed to start', err);
  process.exit(1);
});
