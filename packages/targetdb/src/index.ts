import pg from 'pg';
import {
  decryptSecret,
  assertHostAllowed,
  envAllowlist,
  type EnvelopeCiphertext,
} from '@conductor/security';

// ─────────────────────────────────────────────────────────────────────────────
// Per-project connection pool to a TARGET project DB (spec §7). Shared by
// worker-core (bulk writes) and worker-edge (export reads, REST push reads).
//
// Secret decrypted in-memory only; the host is SSRF-validated and the pool is
// PINNED to the validated IP so it can't re-resolve to a private/metadata
// address later (DNS rebinding). M3–M5 support PostgreSQL targets; MySQL/SQL
// Server target writers are M6.
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectConn {
  id: string;
  provider: 'postgres' | 'mysql' | 'sqlserver';
  host: string;
  port: number;
  database: string;
  schema: string | null;
  username: string;
  secret_ciphertext: EnvelopeCiphertext;
  ssl_mode: string;
  pool_max: number;
  query_timeout_s: number;
  allowlist_hosts: string[];
}

const pools = new Map<string, pg.Pool>();

export async function getTargetPool(p: ProjectConn): Promise<pg.Pool> {
  if (p.provider !== 'postgres') {
    throw new Error(`target provider '${p.provider}' not yet supported (PostgreSQL only through M5)`);
  }
  let pool = pools.get(p.id);
  if (!pool) {
    const { resolvedIps } = await assertHostAllowed(p.host, [...envAllowlist(), ...p.allowlist_hosts]);
    const connectIp = resolvedIps[0]!;
    const useSsl = p.ssl_mode && !['disable', 'prefer'].includes(p.ssl_mode);
    pool = new pg.Pool({
      host: connectIp, // validated IP, not the hostname (anti-rebinding)
      port: p.port,
      database: p.database,
      user: p.username,
      password: decryptSecret(p.secret_ciphertext),
      ssl: useSsl ? { rejectUnauthorized: p.ssl_mode === 'verify-full', servername: p.host } : undefined,
      max: p.pool_max,
      statement_timeout: p.query_timeout_s * 1000,
      idleTimeoutMillis: 30_000,
    });
    pool.on('error', (err) => console.error(`[target ${p.id}] pool error`, err.message));
    pools.set(p.id, pool);
  }
  return pool;
}

export async function closeAllTargetPools(): Promise<void> {
  for (const pool of pools.values()) await pool.end().catch(() => {});
  pools.clear();
}

/** Safe SQL identifier (quoted, validated). Throws on anything non-identifier. */
export function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}

/** column_name -> data_type for a target table (from information_schema). */
export async function introspectColumns(
  pool: pg.Pool,
  schema: string,
  table: string,
): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema=$1 AND table_name=$2`,
    [schema, table],
  );
  if (rows.length === 0) throw new Error(`target table ${schema}.${table} not found`);
  return new Map(rows.map((r) => [r.column_name, r.data_type]));
}

/** Coerce a CSV/JSON string value to a JS value appropriate for a PG column type. */
export function coerce(v: unknown, dataType?: string): unknown {
  if (v === undefined || v === null || v === '') return null;
  if (!dataType) return v;
  if (/int/.test(dataType)) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  if (/numeric|decimal|real|double/.test(dataType)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (/bool/.test(dataType)) return /^(true|1|t|yes)$/i.test(String(v));
  return v;
}
