import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { query } from '@conductor/db';
import type { Role } from '@conductor/contracts';
import { config } from '../config.js';

export interface Principal {
  sub: string; // user id or api-key id
  email: string; // email or "apikey:<name>"
  role: Role;
  kind: 'user' | 'apikey';
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: Principal;
    user: Principal;
  }
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

export async function registerAuth(app: FastifyInstance): Promise<void> {
  await app.register(fastifyJwt, {
    secret: config.jwt.secret,
    sign: { iss: config.jwt.issuer, expiresIn: config.jwt.expiresIn },
    verify: { allowedIss: config.jwt.issuer },
  });

  // Authenticate via JWT (Authorization: Bearer) OR API key (x-api-key).
  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    const apiKey = req.headers['x-api-key'];
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      const principal = await resolveApiKey(apiKey);
      if (!principal) return reply.code(401).send({ error: 'invalid api key' });
      req.principal = principal;
      return;
    }
    try {
      const payload = await req.jwtVerify<Principal>();
      req.principal = { ...payload, kind: 'user' };
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  // RBAC guard factory: requires at least the given role (admin > operator > viewer).
  app.decorate('requireRole', (min: Role) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.principal) return reply.code(401).send({ error: 'unauthorized' });
      if (ROLE_RANK[req.principal.role] < ROLE_RANK[min]) {
        return reply.code(403).send({ error: 'forbidden', required: min });
      }
    };
  });
}

async function resolveApiKey(rawKey: string): Promise<Principal | null> {
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const { rows } = await query<{ id: string; name: string; role: Role }>(
    `SELECT id, name, role FROM api_keys
       WHERE key_hash = $1 AND revoked_at IS NULL`,
    [keyHash],
  );
  const row = rows[0];
  if (!row) return null;
  await query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]);
  return { sub: row.id, email: `apikey:${row.name}`, role: row.role, kind: 'apikey' };
}

// Fastify decorator typing
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (min: Role) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
