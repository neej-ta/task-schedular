import { query } from '@conductor/db';

export interface JobRow {
  id: string;
  definition_id: string | null;
  project_id: string;
  entity: string;
  type: string;
  status: string;
  idempotency_key: string | null;
  rule_set_id: string | null;
  parameters_jsonb: Record<string, unknown>;
  source_jsonb: Record<string, unknown>;
  destination_jsonb: Record<string, unknown>;
  priority: number;
  attempt: number;
  max_attempts: number;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  worker_id: string | null;
  error_summary: string | null;
}

export interface JobFilter {
  status?: string;
  projectId?: string;
  type?: string;
  from?: string;
  to?: string;
  q?: string;
  limit: number;
  offset: number;
}

export async function listJobs(f: JobFilter): Promise<{ jobs: JobRow[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (f.status) {
    where.push(`status = $${i++}`);
    params.push(f.status);
  }
  if (f.projectId) {
    where.push(`project_id = $${i++}`);
    params.push(f.projectId);
  }
  if (f.type) {
    where.push(`type = $${i++}`);
    params.push(f.type);
  }
  if (f.from) {
    where.push(`queued_at >= $${i++}`);
    params.push(f.from);
  }
  if (f.to) {
    where.push(`queued_at <= $${i++}`);
    params.push(f.to);
  }
  if (f.q) {
    // Escape ILIKE wildcards so user input can't act as a pattern (LIKE-injection).
    const escaped = f.q.replace(/[\\%_]/g, (c) => `\\${c}`);
    where.push(`(id::text ILIKE $${i} OR entity ILIKE $${i} OR type ILIKE $${i})`);
    params.push(`%${escaped}%`);
    i++;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRes = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM jobs ${whereSql}`,
    params,
  );
  const total = totalRes.rows[0]?.count ?? 0;

  const { rows } = await query<JobRow>(
    `SELECT * FROM jobs ${whereSql} ORDER BY queued_at DESC LIMIT $${i++} OFFSET $${i++}`,
    [...params, f.limit, f.offset],
  );
  return { jobs: rows, total };
}

export async function getJob(id: string): Promise<JobRow | null> {
  const { rows } = await query<JobRow>('SELECT * FROM jobs WHERE id=$1', [id]);
  return rows[0] ?? null;
}
