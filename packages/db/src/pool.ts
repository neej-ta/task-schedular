import pg from 'pg';

const { Pool } = pg;

// pg returns BIGINT (int8) as a string by default to avoid precision loss.
// Our bigints (row counts, ids) fit safely in JS numbers for display; parse them.
pg.types.setTypeParser(20 /* int8 */, (v) => (v === null ? null : Number(v)));

let pool: pg.Pool | null = null;

/** Shared connection pool to the CONTROL-PLANE database (not target project DBs). */
export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    // A dedicated (project-mode) worker sets CONTROL_DB_SEARCH_PATH to
    // `proj_<id>,public` so unqualified table names resolve to the project's
    // execution schema (M7 Phase 2). Sent as a libpq startup option so it's in
    // effect before the first query — no per-connection SET race. Validated to
    // our generated shape to keep it injection-safe.
    const searchPath = process.env.CONTROL_DB_SEARCH_PATH;
    if (searchPath && !/^proj_[0-9a-f]{32},public$/.test(searchPath)) {
      throw new Error(`CONTROL_DB_SEARCH_PATH must be "proj_<hex>,public", got: ${searchPath}`);
    }
    pool = new Pool({
      connectionString,
      max: Number(process.env.CONTROL_DB_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ...(searchPath ? { options: `-c search_path=${searchPath}` } : {}),
    });
    pool.on('error', (err) => {
      // Background pool errors must not crash the process.
      console.error('[db] idle client error', err.message);
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as never[]);
}

/** Run `fn` inside a single transaction; commits on success, rolls back on throw. */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
