import type { Channel } from 'amqplib';
import {
  JOBS_EXCHANGE,
  DELAYED_EXCHANGE,
  DLX_EXCHANGE,
  DLQ_NAME,
  JOB_TYPES,
  routingKeyForType,
  queueForType,
} from '@conductor/contracts';

// ─────────────────────────────────────────────────────────────────────────────
// RabbitMQ topology (spec §4, §13). Idempotent — safe to assert from every
// publisher/consumer on startup.
//
//   conductor.jobs    (direct)            ─┐ route by conductor.job.<type>
//   conductor.delayed (x-delayed-message) ─┴─► conductor.q.<type>  (one per type)
//                                                     │ x-dead-letter-exchange
//                                                     ▼
//                                          conductor.dlx (fanout) ─► conductor.dlq
// ─────────────────────────────────────────────────────────────────────────────

export async function assertTopology(ch: Channel): Promise<void> {
  await ch.assertExchange(JOBS_EXCHANGE, 'direct', { durable: true });
  await ch.assertExchange(DELAYED_EXCHANGE, 'x-delayed-message', {
    durable: true,
    arguments: { 'x-delayed-type': 'direct' },
  });
  await ch.assertExchange(DLX_EXCHANGE, 'fanout', { durable: true });

  await ch.assertQueue(DLQ_NAME, { durable: true });
  await ch.bindQueue(DLQ_NAME, DLX_EXCHANGE, '');

  for (const type of JOB_TYPES) {
    const queue = queueForType(type);
    const rk = routingKeyForType(type);
    await ch.assertQueue(queue, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': DLX_EXCHANGE },
    });
    await ch.bindQueue(queue, JOBS_EXCHANGE, rk);
    await ch.bindQueue(queue, DELAYED_EXCHANGE, rk);
  }
}
