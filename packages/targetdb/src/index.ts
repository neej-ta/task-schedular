import { PostgresTargetDb } from './postgres.js';
import { SqlServerTargetDb } from './sqlserver.js';
import { MySqlTargetDb } from './mysql.js';
import { type ProjectConn, type TargetDb } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Per-project connection to a TARGET project DB (spec §7). Shared by worker-core
// (bulk writes) and worker-edge (export reads, REST push reads).
//
// The secret is decrypted in-memory only; the host is SSRF-validated and the
// pool is PINNED to the validated IP so it can't re-resolve to a private/metadata
// address later (DNS rebinding). PostgreSQL, SQL Server, and MySQL targets are
// all supported for job execution.
// ─────────────────────────────────────────────────────────────────────────────

export { type ProjectConn, type TargetDb, type ColumnTypes, type QueryResult, type TargetClient, type TargetProvider, coerce } from './types.js';

const dbs = new Map<string, TargetDb>();

/** Get (or open) the cached TargetDb for a project, dispatched by provider. */
export async function getTargetDb(p: ProjectConn): Promise<TargetDb> {
  let db = dbs.get(p.id);
  if (db) return db;

  if (p.provider === 'postgres') {
    db = await PostgresTargetDb.connect(p);
  } else if (p.provider === 'sqlserver') {
    db = await SqlServerTargetDb.connect(p);
  } else if (p.provider === 'mysql') {
    db = await MySqlTargetDb.connect(p);
  } else {
    throw new Error(`target provider '${p.provider}' is not supported for job execution`);
  }
  dbs.set(p.id, db);
  return db;
}

export async function closeAllTargetPools(): Promise<void> {
  for (const db of dbs.values()) await db.close();
  dbs.clear();
}
