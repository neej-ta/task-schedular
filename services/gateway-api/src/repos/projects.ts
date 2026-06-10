import { query } from '@conductor/db';
import type { Provider } from '@conductor/contracts';
import { encryptSecret, decryptSecret, type EnvelopeCiphertext } from '@conductor/security';

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  environment: 'prod' | 'test';
  status: 'active' | 'disabled';
  provider: Provider;
  host: string;
  port: number;
  database: string;
  schema: string | null;
  username: string;
  secret_ciphertext: EnvelopeCiphertext;
  secret_key_id: string;
  ssl_mode: string;
  options_jsonb: Record<string, unknown>;
  pool_max: number;
  query_timeout_s: number;
  max_rows: number;
  concurrency_limit: number;
  allowlist_hosts: string[];
  created_at: string;
  updated_at: string;
}

/** A project as exposed via the API — secret is ALWAYS masked, never plaintext. */
export interface ProjectView extends Omit<ProjectRow, 'secret_ciphertext' | 'secret_key_id'> {
  secretMasked: string;
}

export function toView(row: ProjectRow): ProjectView {
  const { secret_ciphertext: _s, secret_key_id: _k, ...rest } = row;
  return { ...rest, secretMasked: '••••••••' };
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  environment: 'prod' | 'test';
  provider: Provider;
  host: string;
  port: number;
  database: string;
  schema?: string;
  username: string;
  secret: string; // plaintext password/connection string — encrypted before store
  sslMode?: string;
  options?: Record<string, unknown>;
  poolMax?: number;
  queryTimeoutS?: number;
  maxRows?: number;
  concurrencyLimit?: number;
  allowlistHosts?: string[];
}

export async function createProject(
  input: CreateProjectInput,
  createdBy: string | null,
): Promise<ProjectRow> {
  const cipher = encryptSecret(input.secret);
  const { rows } = await query<ProjectRow>(
    `INSERT INTO projects
       (name, description, environment, provider, host, port, database, schema,
        username, secret_ciphertext, secret_key_id, ssl_mode, options_jsonb,
        pool_max, query_timeout_s, max_rows, concurrency_limit, allowlist_hosts, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING *`,
    [
      input.name,
      input.description ?? null,
      input.environment,
      input.provider,
      input.host,
      input.port,
      input.database,
      input.schema ?? null,
      input.username,
      JSON.stringify(cipher),
      cipher.keyId,
      input.sslMode ?? 'prefer',
      JSON.stringify(input.options ?? {}),
      input.poolMax ?? 5,
      input.queryTimeoutS ?? 30,
      input.maxRows ?? 5_000_000,
      input.concurrencyLimit ?? 4,
      input.allowlistHosts ?? [],
      createdBy,
    ],
  );
  return rows[0]!;
}

export async function listProjects(): Promise<ProjectRow[]> {
  const { rows } = await query<ProjectRow>(
    `SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY created_at DESC`,
  );
  return rows;
}

export async function getProject(id: string): Promise<ProjectRow | null> {
  const { rows } = await query<ProjectRow>(
    `SELECT * FROM projects WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] ?? null;
}

const PATCHABLE: Record<string, string> = {
  name: 'name',
  description: 'description',
  environment: 'environment',
  status: 'status',
  host: 'host',
  port: 'port',
  database: 'database',
  schema: 'schema',
  username: 'username',
  sslMode: 'ssl_mode',
  poolMax: 'pool_max',
  queryTimeoutS: 'query_timeout_s',
  maxRows: 'max_rows',
  concurrencyLimit: 'concurrency_limit',
  allowlistHosts: 'allowlist_hosts',
};

export async function updateProject(
  id: string,
  patch: Record<string, unknown> & { secret?: string; options?: Record<string, unknown> },
): Promise<ProjectRow | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  for (const [key, col] of Object.entries(PATCHABLE)) {
    if (patch[key] !== undefined) {
      sets.push(`${col} = $${i++}`);
      values.push(patch[key]);
    }
  }
  if (patch.options !== undefined) {
    sets.push(`options_jsonb = $${i++}`);
    values.push(JSON.stringify(patch.options));
  }
  if (patch.secret !== undefined) {
    const cipher = encryptSecret(patch.secret);
    sets.push(`secret_ciphertext = $${i++}`);
    values.push(JSON.stringify(cipher));
    sets.push(`secret_key_id = $${i++}`);
    values.push(cipher.keyId);
  }
  if (sets.length === 0) return getProject(id);

  sets.push(`updated_at = now()`);
  values.push(id);
  const { rows } = await query<ProjectRow>(
    `UPDATE projects SET ${sets.join(', ')}
       WHERE id = $${i} AND deleted_at IS NULL RETURNING *`,
    values,
  );
  return rows[0] ?? null;
}

export async function softDeleteProject(id: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE projects SET deleted_at = now(), status = 'disabled'
       WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

/** Decrypt a project's secret in-memory. Callers must never log the result. */
export function revealSecret(row: ProjectRow): string {
  return decryptSecret(row.secret_ciphertext);
}
