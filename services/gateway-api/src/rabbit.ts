import { createConfirmChannel, publishWithConfirm } from '@conductor/messaging';
import { DLQ_NAME, routingKeyForType, QUEUE_PREFIX } from '@conductor/contracts';
import { query } from '@conductor/db';

// RabbitMQ ops helpers for the dashboard Workers page (queue depths + DLQ replay).

const MGMT_URL = process.env.RABBITMQ_MGMT_URL ?? 'http://rabbitmq:15672';
const MGMT_USER = process.env.RABBITMQ_USER ?? 'conductor';
const MGMT_PASS = process.env.RABBITMQ_PASS ?? 'conductor_dev_pw';

export interface QueueInfo {
  name: string;
  messages: number;
  messagesReady: number;
  messagesUnacked: number;
}

/** Queue depths via the RabbitMQ management API (conductor.* queues + DLQ). */
export async function getQueues(): Promise<QueueInfo[]> {
  const auth = Buffer.from(`${MGMT_USER}:${MGMT_PASS}`).toString('base64');
  const res = await fetch(`${MGMT_URL}/api/queues/%2F`, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`rabbit mgmt API → HTTP ${res.status}`);
  const queues = (await res.json()) as Array<{
    name: string;
    messages?: number;
    messages_ready?: number;
    messages_unacknowledged?: number;
  }>;
  return queues
    .filter((q) => q.name.startsWith(QUEUE_PREFIX))
    .map((q) => ({
      name: q.name,
      messages: q.messages ?? 0,
      messagesReady: q.messages_ready ?? 0,
      messagesUnacked: q.messages_unacknowledged ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Replay dead-lettered messages back onto the jobs exchange (spec §15). Reads up
 * to `max` messages from the DLQ and re-publishes each by its envelope type's
 * routing key, so the worker reprocesses them. Returns the count replayed.
 */
export async function replayDlq(max = 100): Promise<number> {
  const ch = await createConfirmChannel();
  let replayed = 0;
  try {
    for (let i = 0; i < max; i++) {
      const msg = await ch.get(DLQ_NAME, { noAck: false });
      if (!msg) break;
      try {
        const envelope = JSON.parse(msg.content.toString()) as { type?: string; jobId?: string };
        const type = envelope.type;
        if (!type) {
          ch.nack(msg, false, true); // unparseable — put it BACK in the DLQ, don't destroy
          break;
        }
        // Reset the job so the worker can re-claim it (otherwise a 'failed' job
        // is skipped on delivery and replay is a silent no-op — review H4).
        if (envelope.jobId) {
          await query(
            `UPDATE jobs SET status='queued', attempt=1, error_summary=NULL, started_at=NULL, finished_at=NULL
               WHERE id=$1 AND status IN ('failed','cancelled')`,
            [envelope.jobId],
          );
        }
        const replayEnvelope = { ...envelope, attempt: 1 };
        await publishWithConfirm(ch, routingKeyForType(type), replayEnvelope, { messageId: envelope.jobId });
        ch.ack(msg);
        replayed++;
      } catch {
        ch.nack(msg, false, true); // put it back on transient failure
        break;
      }
    }
  } finally {
    await ch.close().catch(() => {});
  }
  return replayed;
}
