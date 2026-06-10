import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ProviderSchema } from '@conductor/contracts';
import {
  createProject,
  listProjects,
  getProject,
  updateProject,
  softDeleteProject,
  toView,
  revealSecret,
} from '../repos/projects.js';
import { assertHostAllowed, SsrfError } from '@conductor/security';
import { testConnection } from '../providers/testConnection.js';
import { audit } from '../audit.js';
import { config } from '../config.js';

const CreateBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  environment: z.enum(['prod', 'test']).default('test'),
  provider: ProviderSchema,
  host: z.string().min(1),
  port: z.number().int().positive(),
  database: z.string().min(1),
  schema: z.string().optional(),
  username: z.string().min(1),
  secret: z.string().min(1),
  sslMode: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  poolMax: z.number().int().positive().optional(),
  queryTimeoutS: z.number().int().positive().optional(),
  maxRows: z.number().int().positive().optional(),
  concurrencyLimit: z.number().int().positive().optional(),
  allowlistHosts: z.array(z.string()).optional(),
});

const PatchBody = CreateBody.partial().extend({
  status: z.enum(['active', 'disabled']).optional(),
});

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  const viewer = { preHandler: [app.authenticate, app.requireRole('viewer')] };
  const operator = { preHandler: [app.authenticate, app.requireRole('operator')] };
  const admin = { preHandler: [app.authenticate, app.requireRole('admin')] };

  // List — secrets masked.
  app.get('/projects', viewer, async () => {
    const rows = await listProjects();
    return { projects: rows.map(toView) };
  });

  app.get('/projects/:id', viewer, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await getProject(id);
    if (!row) return reply.code(404).send({ error: 'not found' });
    return { project: toView(row) };
  });

  // Create (Admin only).
  app.post('/projects', admin, async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.flatten() });
    }
    const row = await createProject(parsed.data, req.principal!.sub);
    await audit(req.principal, 'project.create', { target: row.id, projectId: row.id });
    return reply.code(201).send({ project: toView(row) });
  });

  // Update (Admin only) — can set a new secret; never echoes it back.
  app.patch('/projects/:id', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.flatten() });
    }
    const row = await updateProject(id, parsed.data);
    if (!row) return reply.code(404).send({ error: 'not found' });
    await audit(req.principal, 'project.update', {
      target: id,
      projectId: id,
      data: { fields: Object.keys(parsed.data).filter((k) => k !== 'secret') },
    });
    return { project: toView(row) };
  });

  // Soft delete (Admin only).
  app.delete('/projects/:id', admin, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await softDeleteProject(id);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    await audit(req.principal, 'project.delete', { target: id, projectId: id });
    return reply.code(204).send();
  });

  // Test connection (Operator+). SSRF-guarded; decrypts in-memory; never returns secret.
  app.post('/projects/:id/test-connection', operator, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await getProject(id);
    if (!row) return reply.code(404).send({ error: 'not found' });

    let connectIp: string | undefined;
    try {
      // Merge the global allow-list with this project's admin-approved hosts.
      // Pin the connection to a validated IP to defeat DNS rebinding (spec §7).
      const { resolvedIps } = await assertHostAllowed(row.host, [
        ...config.ssrfAllowlist,
        ...row.allowlist_hosts,
      ]);
      connectIp = resolvedIps[0];
    } catch (err) {
      if (err instanceof SsrfError) {
        await audit(req.principal, 'project.connection.blocked', {
          target: id,
          projectId: id,
          data: { reason: err.message },
        });
        return reply.code(403).send({ ok: false, error: err.message });
      }
      throw err;
    }

    const result = await testConnection({
      provider: row.provider,
      host: row.host,
      connectIp,
      port: row.port,
      database: row.database,
      schema: row.schema,
      username: row.username,
      password: revealSecret(row), // in-memory only
      sslMode: row.ssl_mode,
      queryTimeoutS: row.query_timeout_s,
    });

    await audit(req.principal, 'project.connection.test', {
      target: id,
      projectId: id,
      data: { ok: result.ok, latencyMs: result.latencyMs }, // no secret, no error detail leak beyond ok
    });

    return reply.code(result.ok ? 200 : 502).send(result);
  });
}
