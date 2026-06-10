import { query } from '@conductor/db';
import type { Principal } from './auth/plugin.js';

/** Record a mutation or a project-connection use in the audit log (spec §17). */
export async function audit(
  actor: Principal | undefined,
  action: string,
  opts: { target?: string; projectId?: string; jobId?: string; data?: unknown } = {},
): Promise<void> {
  await query(
    `INSERT INTO audit_log(actor, action, target, project_id, job_id, data_jsonb)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      actor?.email ?? 'system',
      action,
      opts.target ?? null,
      opts.projectId ?? null,
      opts.jobId ?? null,
      opts.data ? JSON.stringify(opts.data) : null,
    ],
  );
}
