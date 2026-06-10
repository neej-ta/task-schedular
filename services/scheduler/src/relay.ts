import type { ConfirmChannel } from 'amqplib';
import { withTransaction } from '@conductor/db';
import { createConfirmChannel, publishWithConfirm } from '@conductor/messaging';
import { config } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Outbox relay (spec §5.2). Drains pending outbox rows and publishes them to
// RabbitMQ with publisher confirms, marking each row `sent` only after the
// broker acks. Runs on EVERY scheduler instance — `FOR UPDATE SKIP LOCKED` lets
// instances share the work without double-publishing a row.
// ─────────────────────────────────────────────────────────────────────────────

interface OutboxRow {
  id: string;
  routing_key: string;
  payload_jsonb: {
    priority?: number;
    correlationId?: string;
    jobId?: string;
    options?: { delayMs?: number };
  };
  attempts: number;
}

export class OutboxRelay {
  private channel: ConfirmChannel | null = null;

  constructor(private readonly log: (msg: string) => void) {}

  private async getChannel(): Promise<ConfirmChannel> {
    if (this.channel) return this.channel;
    this.channel = await createConfirmChannel();
    this.channel.on('close', () => {
      this.channel = null;
    });
    this.channel.on('error', () => {
      this.channel = null;
    });
    return this.channel;
  }

  /** Process one batch of pending outbox rows. Returns the number sent. */
  async tick(): Promise<number> {
    const ch = await this.getChannel();
    return withTransaction(async (client) => {
      const { rows } = await client.query<OutboxRow>(
        `SELECT id, routing_key, payload_jsonb, attempts
           FROM outbox
          WHERE status = 'pending'
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT $1`,
        [config.relayBatch],
      );

      let sent = 0;
      for (const row of rows) {
        try {
          await publishWithConfirm(ch, row.routing_key, row.payload_jsonb, {
            priority: row.payload_jsonb.priority,
            correlationId: row.payload_jsonb.correlationId,
            messageId: row.payload_jsonb.jobId,
          });
          await client.query(
            `UPDATE outbox SET status='sent', sent_at=now(), attempts=attempts+1 WHERE id=$1`,
            [row.id],
          );
          sent++;
        } catch (err) {
          const attempts = row.attempts + 1;
          const failed = attempts >= config.maxOutboxAttempts;
          await client.query(`UPDATE outbox SET attempts=$2, status=$3 WHERE id=$1`, [
            row.id,
            attempts,
            failed ? 'failed' : 'pending',
          ]);
          this.log(
            `[relay] publish failed for ${row.id} (attempt ${attempts}${failed ? ', GIVING UP' : ''}): ${(err as Error).message}`,
          );
        }
      }
      if (sent > 0) this.log(`[relay] published ${sent} message(s)`);
      return sent;
    });
  }

  async close(): Promise<void> {
    if (this.channel) {
      await this.channel.close().catch(() => {});
      this.channel = null;
    }
  }
}
