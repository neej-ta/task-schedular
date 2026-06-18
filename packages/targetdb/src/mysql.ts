import * as mysql from 'mysql2/promise';
import { decryptSecret, assertHostAllowed, envAllowlist } from '@conductor/security';
import {
  assertSafeIdent,
  type ColumnTypes,
  type ProjectConn,
  type QueryResult,
  type TargetDb,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// MySQL target adapter. Mirrors the Postgres/SQL Server adapters but speaks
// MySQL: `backtick` quoting, native `?` placeholders (no rewrite), NOW(),
// INSERT IGNORE for the idempotent promote, and MySQL error numbers. In MySQL a
// schema IS a database, and the pool is bound to `project.database`, so target
// objects are referenced unqualified (the passed PG-style schema is ignored).
// The pool connects to the SSRF-validated IP (spec §7).
// ─────────────────────────────────────────────────────────────────────────────

const UNIQUE_ERR = 1062; // ER_DUP_ENTRY
// Per-row data/constraint errors (truncation, out-of-range, wrong value, null
// into not-null, too-long, FK, check) — attributed to the offending row.
const DATA_ERR = new Set([1048, 1264, 1265, 1292, 1366, 1406, 1452, 1690, 3819]);

interface RawCol {
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
}

export class MySqlTargetDb implements TargetDb {
  readonly provider = 'mysql' as const;
  readonly maxBindParams = 65535;

  constructor(
    private readonly pool: mysql.Pool,
    private readonly database: string,
  ) {}

  static async connect(p: ProjectConn): Promise<MySqlTargetDb> {
    const { resolvedIps } = await assertHostAllowed(p.host, [...envAllowlist(), ...p.allowlist_hosts]);
    const connectIp = resolvedIps[0]!;
    const useSsl = p.ssl_mode && p.ssl_mode !== 'disable';
    const pool = mysql.createPool({
      host: connectIp, // validated IP, not the hostname (anti-rebinding)
      port: p.port,
      database: p.database,
      user: p.username,
      password: decryptSecret(p.secret_ciphertext),
      ssl: useSsl ? { rejectUnauthorized: p.ssl_mode === 'verify-full' } : undefined,
      connectionLimit: p.pool_max,
      connectTimeout: p.query_timeout_s * 1000,
      waitForConnections: true,
    });
    return new MySqlTargetDb(pool, p.database);
  }

  /** MySQL uses `?` placeholders natively, so no rewrite is needed. */
  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const [result] = await this.pool.query(sql, params);
    if (Array.isArray(result)) return { rows: result as T[], rowCount: result.length };
    return { rows: [], rowCount: (result as mysql.ResultSetHeader).affectedRows ?? 0 };
  }

  ident(name: string): string {
    return `\`${assertSafeIdent(name)}\``;
  }
  qualify(_schema: string, name: string): string {
    return this.ident(name); // connection is bound to the database; no schema prefix
  }
  now(): string {
    return 'NOW()';
  }
  castText(expr: string): string {
    return `CAST(${expr} AS CHAR)`;
  }

  isUniqueViolation(err: unknown): boolean {
    return (err as { errno?: number }).errno === UNIQUE_ERR;
  }
  isDataError(err: unknown): boolean {
    return DATA_ERR.has((err as { errno?: number }).errno ?? -1);
  }

  async introspectColumns(_schema: string, table: string): Promise<ColumnTypes> {
    // COLUMN_TYPE is the full DDL-ready type (e.g. `varchar(255)`, `decimal(10,2)`).
    const [rows] = await this.pool.query(
      `SELECT column_name AS COLUMN_NAME, column_type AS COLUMN_TYPE
         FROM information_schema.columns WHERE table_schema=? AND table_name=?`,
      [this.database, table],
    );
    const cols = rows as RawCol[];
    if (cols.length === 0) throw new Error(`target table ${this.database}.${table} not found`);
    return new Map(cols.map((c) => [c.COLUMN_NAME, c.COLUMN_TYPE]));
  }

  async existsOne(tableExpr: string, whereSql: string, params: unknown[]): Promise<boolean> {
    const [rows] = await this.pool.query(`SELECT 1 FROM ${tableExpr} WHERE ${whereSql} LIMIT 1`, params);
    return Array.isArray(rows) && rows.length > 0;
  }

  async createStaging(
    _schema: string,
    staging: string,
    targetCols: string[],
    colTypes: ColumnTypes,
    uniqueTargetCols: string[],
  ): Promise<void> {
    await this.dropStagingIfExists(_schema, staging);
    const colDefs = targetCols.map((c) => `${this.ident(c)} ${colTypes.get(c) ?? 'text'}`).join(', ');
    // `row_number` is a reserved word in MySQL 8 — always quote it.
    await this.pool.query(
      `CREATE TABLE ${this.ident(staging)} (${this.ident('row_number')} BIGINT PRIMARY KEY, ${colDefs})`,
    );
    for (const col of uniqueTargetCols) {
      // MySQL UNIQUE indexes already allow multiple NULLs (matches PG/SQL Server
      // here). Index name is table-scoped, so keep it short (64-char id limit).
      await this.pool.query(
        `CREATE UNIQUE INDEX ${this.ident(`uq_${col}`)} ON ${this.ident(staging)} (${this.ident(col)})`,
      );
    }
  }

  async dropStagingIfExists(_schema: string, staging: string): Promise<void> {
    await this.pool.query(`DROP TABLE IF EXISTS ${this.ident(staging)}`);
  }

  async promote(
    _schema: string,
    target: string,
    staging: string,
    cols: string[],
    _uniqueTargetCols: string[],
  ): Promise<number> {
    const colsSql = cols.map((c) => this.ident(c)).join(', ');
    // INSERT IGNORE skips rows that would violate ANY unique/PK constraint —
    // equivalent to PG's ON CONFLICT DO NOTHING; idempotent on re-run.
    const [result] = await this.pool.query(
      `INSERT IGNORE INTO ${this.ident(target)} (${colsSql}) SELECT ${colsSql} FROM ${this.ident(staging)}`,
    );
    return (result as mysql.ResultSetHeader).affectedRows ?? 0;
  }

  async deleteStagingRows(_schema: string, staging: string, rowNumbers: number[]): Promise<void> {
    if (rowNumbers.length === 0) return;
    const rn = this.ident('row_number');
    for (let i = 0; i < rowNumbers.length; i += 1000) {
      const list = rowNumbers
        .slice(i, i + 1000)
        .map((n) => Math.trunc(Number(n)))
        .join(',');
      await this.pool.query(`DELETE FROM ${this.ident(staging)} WHERE ${rn} IN (${list})`);
    }
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }
}
