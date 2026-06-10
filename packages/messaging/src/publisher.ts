import type { ConfirmChannel } from 'amqplib';
import { JOBS_EXCHANGE, DELAYED_EXCHANGE } from '@conductor/contracts';

export interface PublishOptions {
  /** Delay in ms before delivery (routes via the delayed exchange). */
  delayMs?: number;
  priority?: number;
  messageId?: string;
  correlationId?: string;
  /** Reject if the broker doesn't confirm within this many ms (default 15s). */
  confirmTimeoutMs?: number;
}

/**
 * Publish a job message with a publisher confirm (spec §5.2). Resolves only
 * after the broker acks the message; rejects on nack/timeout so the caller
 * (the outbox relay) can keep the row pending and retry.
 */
export async function publishWithConfirm(
  ch: ConfirmChannel,
  routingKey: string,
  payload: unknown,
  opts: PublishOptions = {},
): Promise<void> {
  const exchange = opts.delayMs && opts.delayMs > 0 ? DELAYED_EXCHANGE : JOBS_EXCHANGE;
  const headers = opts.delayMs && opts.delayMs > 0 ? { 'x-delay': opts.delayMs } : undefined;
  const timeoutMs = opts.confirmTimeoutMs ?? 15_000;

  await new Promise<void>((resolve, reject) => {
    // A channel/connection drop can swallow the confirm callback forever; bound
    // the wait so callers (the relay/worker) can't hang on an open transaction.
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`publisher confirm timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    ch.publish(
      exchange,
      routingKey,
      Buffer.from(JSON.stringify(payload)),
      {
        persistent: true, // survive broker restart
        contentType: 'application/json',
        priority: opts.priority,
        messageId: opts.messageId,
        correlationId: opts.correlationId,
        headers,
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      },
    );
  });
}
