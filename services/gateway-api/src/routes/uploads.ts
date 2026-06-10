import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { putObject, defaultBucket } from '@conductor/storage';
import { parseUpload } from '../lib/parseUpload.js';
import { audit } from '../audit.js';

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  const operator = { preHandler: [app.authenticate, app.requireRole('operator')] };

  // Upload a CSV or Excel (.xlsx) file. We normalize to CSV and store it in
  // object storage, then return its s3:// location + detected columns + a small
  // sample so the dashboard can drive the field-mapping step.
  app.post('/uploads', operator, async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'no file uploaded' });

    const buf = await data.toBuffer();
    if (buf.length === 0) return reply.code(400).send({ error: 'the uploaded file is empty' });

    let parsed;
    try {
      parsed = await parseUpload(data.filename, buf);
    } catch (err) {
      return reply.code(400).send({ error: `could not parse file: ${(err as Error).message}` });
    }

    const base = data.filename.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]/g, '_') || 'upload';
    const key = `user/${randomUUID()}-${base}.csv`;
    try {
      await putObject(key, parsed.csvText);
    } catch (err) {
      req.log.error(err, 'upload: putObject failed');
      return reply.code(502).send({ error: 'could not store the uploaded file' });
    }

    await audit(req.principal, 'upload.create', { data: { key, rows: parsed.rowCount } });
    return reply.code(201).send({
      location: `s3://${defaultBucket()}/${key}`,
      columns: parsed.columns,
      sample: parsed.sample,
      rowCount: parsed.rowCount,
    });
  });
}
