import type { EnvelopeCiphertext } from '@conductor/security';

// ─────────────────────────────────────────────────────────────────────────────
// Dialect-agnostic target-DB abstraction (spec §7, §11). A `TargetDb` wraps a
// per-project connection pool to a customer's project database and exposes the
// small set of primitives every bulk handler needs, hiding the SQL-dialect
// differences between PostgreSQL and SQL Server (placeholders, identifier
// quoting, upsert syntax, error codes, staging DDL, …).
//
// PostgreSQL, SQL Server, and MySQL are the supported target providers — each
// has an adapter implementing the TargetDb contract below.
// ─────────────────────────────────────────────────────────────────────────────

export type TargetProvider = 'postgres' | 'sqlserver' | 'mysql';

/** A row from the control-plane `projects` table — the connection spec. */
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

/** Normalized query result, identical shape across drivers. */
export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  /** Rows returned (SELECT) or affected (INSERT/UPDATE/DELETE). */
  rowCount: number;
}

/**
 * A statement runner. SQL is authored with positional `?` placeholders; the
 * implementation rewrites them to the dialect form ($1 / @p1) and binds params
 * in order. (Target SQL in this codebase never contains a literal `?`.)
 */
export interface TargetClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/** column_name → DDL-ready data type (e.g. `integer`, `nvarchar(255)`). */
export type ColumnTypes = Map<string, string>;

/**
 * Per-project handle to a target database. One instance is cached per project id
 * (see getTargetDb). Implementations encapsulate every dialect difference so the
 * handlers stay provider-neutral.
 */
export interface TargetDb extends TargetClient {
  readonly provider: TargetProvider;

  // ── dialect helpers ────────────────────────────────────────────────────────
  /** Quote a single identifier ("col" / [col]). Throws on unsafe input. */
  ident(name: string): string;
  /** Quote and qualify schema.table. */
  qualify(schema: string, name: string): string;
  /** SQL expression for the current timestamp (now() / SYSUTCDATETIME()). */
  now(): string;
  /** Wrap an expression in a cast-to-text, used by the lookup anti-join. */
  castText(expr: string): string;
  /** Largest number of bind parameters a single statement may carry. */
  readonly maxBindParams: number;
  /** True if the driver error is a unique/PK violation. */
  isUniqueViolation(err: unknown): boolean;
  /** True if the error is a per-row data/constraint error (vs. fatal). */
  isDataError(err: unknown): boolean;

  // ── higher-level operations (dialect DDL/DML encapsulated) ───────────────────
  /** Introspect a target table's columns → DDL-ready type per column. */
  introspectColumns(schema: string, table: string): Promise<ColumnTypes>;
  /** Does at least one row match `whereSql` (with `?` params) in `tableExpr`? */
  existsOne(tableExpr: string, whereSql: string, params: unknown[]): Promise<boolean>;
  /** Create the per-job staging table (+ unique indexes on the business keys). */
  createStaging(
    schema: string,
    staging: string,
    targetCols: string[],
    colTypes: ColumnTypes,
    uniqueTargetCols: string[],
  ): Promise<void>;
  /** Drop the staging table if present (safe in a finally). */
  dropStagingIfExists(schema: string, staging: string): Promise<void>;
  /**
   * Idempotently promote staged rows into the target table, returning the count
   * inserted. Duplicates (by the business key, or any existing unique/PK) are
   * skipped — re-runs/redeliveries never double-insert.
   */
  promote(
    schema: string,
    target: string,
    staging: string,
    cols: string[],
    uniqueTargetCols: string[],
  ): Promise<number>;
  /** Delete staged rows by their row_number (used to drop lookup-failed rows). */
  deleteStagingRows(schema: string, staging: string, rowNumbers: number[]): Promise<void>;
  /** Close the underlying pool (used on shutdown). */
  close(): Promise<void>;
}

/** Safe SQL identifier guard — quoted forms still validate the raw name. */
export function assertSafeIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return name;
}

/**
 * Coerce a CSV/JSON string value to a JS value appropriate for a target column
 * type. Type-name matching is broadened to cover both PostgreSQL
 * (`integer`/`numeric`/`boolean`) and SQL Server (`int`/`decimal`/`bit`).
 */
export function coerce(v: unknown, dataType?: string): unknown {
  if (v === undefined || v === null || v === '') return null;
  if (!dataType) return v;
  const t = dataType.toLowerCase();
  if (/bool|\bbit\b/.test(t)) return /^(true|1|t|yes)$/i.test(String(v));
  if (/int/.test(t)) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  if (/numeric|decimal|real|double|float|money/.test(t)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return v;
}
