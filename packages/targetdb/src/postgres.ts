import pg from 'pg';
import { decryptSecret, assertHostAllowed, envAllowlist } from '@conductor/security';
import {
  assertSafeIdent,
  type ColumnTypes,
  type ProjectConn,
  type QueryResult,
  type TargetDb,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// PostgreSQL target adapter. The pool is PINNED to the SSRF-validated IP so it
// can't re-resolve to a private/metadata address later (DNS rebinding, spec §7).
// ─────────────────────────────────────────────────────────────────────────────

/** Rewrite positional `?` placeholders to PostgreSQL `$1, $2, …`. */
function toPg(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export class PostgresTargetDb implements TargetDb {
  readonly provider = 'postgres' as const;
  readonly maxBindParams = 65535;

  constructor(private readonly pool: pg.Pool) {}

  static async connect(p: ProjectConn): Promise<PostgresTargetDb> {
    const { resolvedIps } = await assertHostAllowed(p.host, [...envAllowlist(), ...p.allowlist_hosts]);
    const connectIp = resolvedIps[0]!;
    const useSsl = p.ssl_mode && !['disable', 'prefer'].includes(p.ssl_mode);
    const pool = new pg.Pool({
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
    return new PostgresTargetDb(pool);
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.pool.query<T extends Record<string, unknown> ? T : never>(toPg(sql), params as unknown[]);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
  }

  ident(name: string): string {
    return `"${assertSafeIdent(name)}"`;
  }
  qualify(schema: string, name: string): string {
    return `${this.ident(schema)}.${this.ident(name)}`;
  }
  now(): string {
    return 'now()';
  }
  castText(expr: string): string {
    return `(${expr})::text`;
  }

  isUniqueViolation(err: unknown): boolean {
    return (err as { code?: string }).code === '23505';
  }
  isDataError(err: unknown): boolean {
    const code = (err as { code?: string }).code ?? '';
    // SQLSTATE class 22 = data exception, class 23 = integrity constraint.
    return code.startsWith('22') || code.startsWith('23');
  }

  async introspectColumns(schema: string, table: string): Promise<ColumnTypes> {
    const { rows } = await this.pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema=$1 AND table_name=$2`,
      [schema, table],
    );
    if (rows.length === 0) throw new Error(`target table ${schema}.${table} not found`);
    return new Map(rows.map((r) => [r.column_name, r.data_type]));
  }

  async existsOne(tableExpr: string, whereSql: string, params: unknown[]): Promise<boolean> {
    const res = await this.pool.query(`SELECT 1 FROM ${tableExpr} WHERE ${toPg(whereSql)} LIMIT 1`, params);
    return (res.rowCount ?? 0) > 0;
  }

  async createStaging(
    schema: string,
    staging: string,
    targetCols: string[],
    colTypes: ColumnTypes,
    uniqueTargetCols: string[],
  ): Promise<void> {
    await this.dropStagingIfExists(schema, staging);
    const colDefs = targetCols.map((c) => `${this.ident(c)} ${colTypes.get(c) ?? 'text'}`).join(', ');
    await this.pool.query(
      `CREATE UNLOGGED TABLE ${this.qualify(schema, staging)} (
         row_number bigint PRIMARY KEY,
         ${colDefs}
       )`,
    );
    for (const col of uniqueTargetCols) {
      // Partial index → multiple NULLs allowed (only present business keys dedup).
      await this.pool.query(
        `CREATE UNIQUE INDEX ${this.ident(`uq_${staging}_${col}`)}
           ON ${this.qualify(schema, staging)} (${this.ident(col)})
         WHERE ${this.ident(col)} IS NOT NULL`,
      );
    }
  }

  async dropStagingIfExists(schema: string, staging: string): Promise<void> {
    await this.pool.query(`DROP TABLE IF EXISTS ${this.qualify(schema, staging)}`);
  }

  async promote(
    schema: string,
    target: string,
    staging: string,
    cols: string[],
    _uniqueTargetCols: string[],
  ): Promise<number> {
    const colsSql = cols.map((c) => this.ident(c)).join(', ');
    // Single large INSERT…SELECT — exempt from the per-project statement_timeout
    // (which guards ad-hoc queries) via SET LOCAL inside a transaction.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL statement_timeout = 0');
      const res = await client.query(
        `INSERT INTO ${this.qualify(schema, target)} (${colsSql})
         SELECT ${colsSql} FROM ${this.qualify(schema, staging)}
         ON CONFLICT DO NOTHING`,
      );
      await client.query('COMMIT');
      return res.rowCount ?? 0;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteStagingRows(schema: string, staging: string, rowNumbers: number[]): Promise<void> {
    if (rowNumbers.length === 0) return;
    await this.pool.query(`DELETE FROM ${this.qualify(schema, staging)} WHERE row_number = ANY($1::bigint[])`, [
      rowNumbers,
    ]);
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }
}
