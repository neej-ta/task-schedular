import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '@conductor/db';
import type { Role } from '@conductor/contracts';
import { verifyPassword } from '../auth/password.js';
import type { Principal } from '../auth/plugin.js';

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.flatten() });
    }
    const { email, password } = parsed.data;

    const { rows } = await query<{
      id: string;
      email: string;
      display_name: string;
      role: Role;
      password_hash: string | null;
      status: string;
    }>(`SELECT id, email, display_name, role, password_hash, status FROM users WHERE email = $1`, [
      email,
    ]);
    const user = rows[0];

    // Constant-ish path: always run a compare to avoid user-enumeration timing.
    const hash = user?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinv';
    const ok = await verifyPassword(password, hash);

    if (!user || user.status !== 'active' || !user.password_hash || !ok) {
      return reply.code(401).send({ error: 'invalid credentials' });
    }

    const principal: Principal = {
      sub: user.id,
      email: user.email,
      role: user.role,
      kind: 'user',
    };
    const token = app.jwt.sign(principal);
    return { token, user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role } };
  });

  // Who am I — handy for the dashboard to gate UI by role.
  app.get(
    '/auth/me',
    { preHandler: [app.authenticate] },
    async (req) => ({ principal: req.principal }),
  );
}
