import mssql from 'mssql';
import { decryptSecret, assertHostAllowed, envAllowlist } from '@conductor/security';
import {
  assertSafeIdent,
  type ColumnTypes,
  type ProjectConn,
  type QueryResult,
  type TargetDb,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// SQL Server (MSSQL) target adapter. Mirrors the PostgreSQL adapter's contract
// but speaks T-SQL: [bracket] quoting, @pN parameters, SYSUTCDATETIME(),
// INSERT…WHERE NOT EXISTS for the idempotent promote, filtered unique indexes
// (so multiple NULL business keys are allowed, matching PG semantics), and SQL
// Server error numbers. The pool connects to the SSRF-validated IP (spec §7).
// ─────────────────────────────────────────────────────────────────────────────

// SQL Server caps a single statement at 2100 parameters; leave a small margin.
const MSSQL_MAX_PARAMS = 2000;
// Unique/PK violations.
const UNIQUE_ERR = new Set([2627, 2601]);
// Per-row data/constraint errors (convert failed, truncation, null/FK/check,
// arithmetic overflow) — attributed to the offending row, not fatal.
const DATA_ERR = new Set([245, 220, 241, 515, 547, 8114, 8115, 8152, 2628]);

interface RawCol {
  column_name: string;
  data_type: string;
  char_len: number | null;
  num_prec: number | null;
  num_scale: number | null;
}

/** Build a DDL-ready type string from information_schema metadata. */
function ddlType(r: RawCol): string {
  const t = r.data_type.toLowerCase();
  if (['char', 'varchar', 'nchar', 'nvarchar', 'binary', 'varbinary'].includes(t)) {
    return r.char_len == null || r.char_len < 0 ? `${t}(max)` : `${t}(${r.char_len})`;
  }
  if (t === 'decimal' || t === 'numeric') {
    return `${t}(${r.num_prec ?? 18},${r.num_scale ?? 0})`;
  }
  return t; // int/bigint/bit/float/money/date/datetime2/uniqueidentifier/…
}

export class SqlServerTargetDb implements TargetDb {
  readonly provider = 'sqlserver' as const;
  readonly maxBindParams = MSSQL_MAX_PARAMS;

  constructor(private readonly pool: mssql.ConnectionPool) {}

  static async connect(p: ProjectConn): Promise<SqlServerTargetDb> {
    const { resolvedIps } = await assertHostAllowed(p.host, [...envAllowlist(), ...p.allowlist_hosts]);
    const connectIp = resolvedIps[0]!;
    const pool = new mssql.ConnectionPool({
      server: connectIp, // validated IP, not the hostname (anti-rebinding)
      port: p.port,
      database: p.database,
      user: p.username,
      password: decryptSecret(p.secret_ciphertext),
      pool: { max: p.pool_max, min: 0, idleTimeoutMillis: 30_000 },
      connectionTimeout: p.query_timeout_s * 1000,
      // Worker bulk pool: a generous request timeout so a large promote isn't
      // killed mid-flight (PostgreSQL exempts the promote via SET LOCAL; SQL
      // Server has no per-statement override, so we size the pool for bulk).
      requestTimeout: Math.max(p.query_timeout_s * 1000, 1_800_000),
      options: {
        encrypt: p.ssl_mode !== 'disable',
        trustServerCertificate: p.ssl_mode !== 'verify-full',
        ...(connectIp ? { serverName: p.host } : {}),
      },
    });
    pool.on('error', (err) => console.error(`[target ${p.id}] pool error`, err.message));
    await pool.connect();
    return new SqlServerTargetDb(pool);
  }

  /** Run `?`-placeholder SQL; binds params as @p1, @p2, … in order. */
  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const req = this.pool.request();
    let i = 0;
    const text = sql.replace(/\?/g, () => {
      const name = `p${++i}`;
      req.input(name, params[i - 1] ?? null);
      return `@${name}`;
    });
    const res = await req.query(text);
    const rows = (res.recordset ?? []) as T[];
    const affected = Array.isArray(res.rowsAffected) ? res.rowsAffected.reduce((a, b) => a + b, 0) : 0;
    return { rows, rowCount: res.recordset ? rows.length : affected };
  }

  ident(name: string): string {
    return `[${assertSafeIdent(name)}]`;
  }
  qualify(schema: string, name: string): string {
    return `${this.ident(schema)}.${this.ident(name)}`;
  }
  now(): string {
    return 'SYSUTCDATETIME()';
  }
  castText(expr: string): string {
    return `CAST(${expr} AS NVARCHAR(MAX))`;
  }

  isUniqueViolation(err: unknown): boolean {
    return UNIQUE_ERR.has((err as { number?: number }).number ?? -1);
  }
  isDataError(err: unknown): boolean {
    return DATA_ERR.has((err as { number?: number }).number ?? -1);
  }

  async introspectColumns(schema: string, table: string): Promise<ColumnTypes> {
    const r = await this.pool
      .request()
      .input('schema', schema)
      .input('table', table)
      .query<RawCol>(
        `SELECT column_name, data_type,
                character_maximum_length AS char_len,
                numeric_precision AS num_prec,
                numeric_scale AS num_scale
           FROM information_schema.columns
          WHERE table_schema=@schema AND table_name=@table`,
      );
    if (r.recordset.length === 0) throw new Error(`target table ${schema}.${table} not found`);
    return new Map(r.recordset.map((c) => [c.column_name, ddlType(c)]));
  }

  async existsOne(tableExpr: string, whereSql: string, params: unknown[]): Promise<boolean> {
    const res = await this.query(`SELECT TOP 1 1 AS x FROM ${tableExpr} WHERE ${whereSql}`, params);
    return res.rows.length > 0;
  }

  async createStaging(
    schema: string,
    staging: string,
    targetCols: string[],
    colTypes: ColumnTypes,
    uniqueTargetCols: string[],
  ): Promise<void> {
    await this.dropStagingIfExists(schema, staging);
    const colDefs = targetCols.map((c) => `${this.ident(c)} ${colTypes.get(c) ?? 'nvarchar(max)'}`).join(', ');
    await this.pool.request().query(
      `CREATE TABLE ${this.qualify(schema, staging)} (
         row_number BIGINT PRIMARY KEY,
         ${colDefs}
       )`,
    );
    for (const col of uniqueTargetCols) {
      // Filtered index → multiple NULLs allowed (matches PostgreSQL behavior).
      await this.pool
        .request()
        .query(
          `CREATE UNIQUE INDEX ${this.ident(`uq_${staging}_${col}`)}
             ON ${this.qualify(schema, staging)} (${this.ident(col)})
           WHERE ${this.ident(col)} IS NOT NULL`,
        );
    }
  }

  async dropStagingIfExists(schema: string, staging: string): Promise<void> {
    await this.pool.request().query(`DROP TABLE IF EXISTS ${this.qualify(schema, staging)}`);
  }

  async promote(
    schema: string,
    target: string,
    staging: string,
    cols: string[],
    uniqueTargetCols: string[],
  ): Promise<number> {
    const colsSql = cols.map((c) => this.ident(c)).join(', ');
    // Idempotent insert: skip a row if ANY of its unique business keys already
    // exists in the target — one NOT EXISTS per unique column, ANDed (insert
    // only when NONE collide). This matches PostgreSQL's `ON CONFLICT DO NOTHING`
    // across multiple independent unique constraints, so a partial overlap
    // (e.g. same email, different code) is skipped rather than erroring. The
    // staging unique indexes already removed any intra-batch duplicates.
    let notExists = '';
    if (uniqueTargetCols.length > 0) {
      const tgt = this.qualify(schema, target);
      const clauses = uniqueTargetCols.map(
        (c) => `NOT EXISTS (SELECT 1 FROM ${tgt} t WHERE t.${this.ident(c)} = s.${this.ident(c)})`,
      );
      notExists = ` WHERE ${clauses.join(' AND ')}`;
    }
    const res = await this.pool.request().query(
      `INSERT INTO ${this.qualify(schema, target)} (${colsSql})
       SELECT ${colsSql} FROM ${this.qualify(schema, staging)} s${notExists}`,
    );
    return Array.isArray(res.rowsAffected) ? res.rowsAffected.reduce((a, b) => a + b, 0) : 0;
  }

  async deleteStagingRows(schema: string, staging: string, rowNumbers: number[]): Promise<void> {
    if (rowNumbers.length === 0) return;
    // Row numbers are integers we generate — safe to inline (no array params in
    // T-SQL). Chunk to stay well under statement limits.
    for (let i = 0; i < rowNumbers.length; i += 1000) {
      const list = rowNumbers
        .slice(i, i + 1000)
        .map((n) => Math.trunc(Number(n)))
        .join(',');
      await this.pool.request().query(`DELETE FROM ${this.qualify(schema, staging)} WHERE row_number IN (${list})`);
    }
  }

  async close(): Promise<void> {
    await this.pool.close().catch(() => {});
  }
}
