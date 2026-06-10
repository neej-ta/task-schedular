import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

export const config = {
  instanceId: process.env.INSTANCE_ID ?? `${hostname()}-${randomUUID().slice(0, 8)}`,
  // How often to evaluate schedules (leader only).
  schedulerTickMs: Number(process.env.SCHEDULER_TICK_MS ?? 5000),
  // How often the outbox relay drains pending rows (every instance).
  relayTickMs: Number(process.env.RELAY_TICK_MS ?? 1000),
  relayBatch: Number(process.env.RELAY_BATCH ?? 100),
  maxOutboxAttempts: Number(process.env.MAX_OUTBOX_ATTEMPTS ?? 10),
  // Advisory-lock key for scheduler leader election (single elected leader).
  leaderLockKey: BigInt(process.env.LEADER_LOCK_KEY ?? '4242000001'),
  logLevel: process.env.LOG_LEVEL ?? 'info',
};

export function assertConfig(): void {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  if (!process.env.RABBITMQ_URL) throw new Error('RABBITMQ_URL is not set');
}
