import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { assertHostAllowed, SsrfError } from '@conductor/security';
import { getProject, revealSecret } from '../repos/projects.js';
import { listEntities, upsertEntity } from '../repos/entities.js';
import { listTables, listColumns } from '../providers/introspect.js';
import type { ConnectionParams } from '../providers/testConnection.js';
import { config } from '../config.js';
import { audit } from '../audit.js';

/** Build SSRF-validated connection params for a project, or send 404/403 and return null. */
async function connParamsOrReply(id: string, reply: FastifyReply): Promise<ConnectionParams | null> {
  const row = await getProject(id);
  if (!row) {
    reply.code(404).send({ error: 'not found' });
    return null;
  }
  try {
    const { resolvedIps } = await assertHostAllowed(row.host, [...config.ssrfAllowlist, ...row.allowlist_hosts]);
    return {
      provider: row.provider,
      host: row.host,
      connectIp: resolvedIps[0],
      port: row.port,
      database: row.database,
      schema: row.schema,
      username: row.username,
      password: revealSecret(row), // in-memory only
      sslMode: row.ssl_mode,
      queryTimeoutS: row.query_timeout_s,
    };
  } catch (err) {
    if (err instanceof SsrfError) {
      reply.code(403).send({ error: err.message });
      return null;
    }
    throw err;
  }
}

export async function entityRoutes(app: FastifyInstance): Promise<void> {
  const viewer = { preHandler: [app.authenticate, app.requireRole('viewer')] };
  const operator = { preHandler: [app.authenticate, app.requireRole('operator')] };

  // Tables in the target DB (for the mapping UI's table picker).
  app.get('/projects/:id/tables', operator, async (req, reply) => {
    const params = await connParamsOrReply((req.params as { id: string }).id, reply);
    if (!params) return;
    try {
      return { tables: await listTables(params) };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // Columns of a chosen target table (for source→target mapping dropdowns).
  app.get('/projects/:id/tables/:table/columns', operator, async (req, reply) => {
    const { id, table } = req.params as { id: string; table: string };
    const params = await connParamsOrReply(id, reply);
    if (!params) return;
    try {
      return { columns: await listColumns(params, table) };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // Configured entities for a project.
  app.get('/projects/:id/entities', viewer, async (req) => {
    return { entities: await listEntities((req.params as { id: string }).id) };
  });

  // Create / update an entity mapping (the bit that makes "entity not configured" go away).
  const EntityBody = z.object({
    name: z.string().min(1),
    targetTable: z.string().min(1),
    primaryKey: z.string().min(1),
    mapping: z.record(z.string(), z.string()),
    ruleSetId: z.string().uuid().nullable().optional(),
  });
  app.post('/projects/:id/entities', operator, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await getProject(id))) return reply.code(404).send({ error: 'not found' });
    const parsed = EntityBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.flatten() });
    }
    if (Object.keys(parsed.data.mapping).length === 0) {
      return reply.code(400).send({ error: 'mapping must have at least one field' });
    }
    const ent = await upsertEntity({ projectId: id, ...parsed.data });
    await audit(req.principal, 'entity.upsert', {
      target: ent.id,
      projectId: id,
      data: { name: ent.name, table: ent.target_table },
    });
    return reply.code(201).send({ entity: ent });
  });
}
