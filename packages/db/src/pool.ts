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
    pool = new Pool({
      connectionString,
      max: Number(process.env.CONTROL_DB_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
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
