import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';

// Single shared AMQP connection per process, with lazy (re)connect.

let model: ChannelModel | null = null;

export async function getConnection(url = process.env.RABBITMQ_URL): Promise<ChannelModel> {
  if (!url) throw new Error('RABBITMQ_URL is not set');
  if (model) return model;
  model = await amqp.connect(url);
  model.on('close', () => {
    model = null;
  });
  model.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[amqp] connection error', (err as Error).message);
    model = null;
  });
  return model;
}

/** Open a confirm channel (required for publisher confirms — spec §5.2). */
export async function createConfirmChannel(): Promise<ConfirmChannel> {
  const conn = await getConnection();
  return conn.createConfirmChannel();
}

export async function closeConnection(): Promise<void> {
  if (model) {
    await model.close();
    model = null;
  }
}
