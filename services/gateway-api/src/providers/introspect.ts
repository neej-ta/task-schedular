import type { ConnectionParams } from './testConnection.js';

// ─────────────────────────────────────────────────────────────────────────────
// Read-only schema introspection of a TARGET project DB so the dashboard mapping
// UI can offer real table/column dropdowns. Mirrors testConnection.ts: connects
// to the pre-validated IP (anti-DNS-rebinding), parameterized queries only, and
// closes the connection promptly. Uses ANSI information_schema (works on
// PostgreSQL, MySQL, and SQL Server). Never returns or logs the secret.
// ─────────────────────────────────────────────────────────────────────────────

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
}

/** The schema/namespace to scope introspection to, per provider. */
function schemaFor(p: ConnectionParams): string {
  if (p.provider === 'mysql') return p.database; // MySQL: schema == database
  if (p.provider === 'sqlserver') return p.schema || 'dbo';
  return p.schema || 'public'; // postgres
}

export async function listTables(p: ConnectionParams): Promise<string[]> {
  const schema = schemaFor(p);
  switch (p.provider) {
    case 'postgres': {
      const pg = (await import('pg')).default;
      const client = new pg.Client(pgConfig(p));
      await client.connect();
      try {
        const { rows } = await client.query<{ name: string }>(
          `SELECT table_name AS name FROM information_schema.tables
             WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
          [schema],
        );
        return rows.map((r) => r.name);
      } finally {
        await client.end();
      }
    }
    case 'mysql': {
      const mysql = await import('mysql2/promise');
      const conn = await mysql.createConnection(mysqlConfig(p));
      try {
        const [rows] = await conn.query(
          `SELECT table_name AS name FROM information_schema.tables
             WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name`,
          [schema],
        );
        return (rows as Record<string, unknown>[]).map((r) => String(r.name ?? r.NAME));
      } finally {
        await conn.end();
      }
    }
    case 'sqlserver': {
      const mssql = (await import('mssql')).default;
      const pool = new mssql.ConnectionPool(mssqlConfig(p));
      await pool.connect();
      try {
        const r = await pool
          .request()
          .input('schema', schema)
          .query(
            `SELECT table_name AS name FROM information_schema.tables
               WHERE table_schema = @schema AND table_type = 'BASE TABLE' ORDER BY table_name`,
          );
        return (r.recordset as Record<string, unknown>[]).map((x) => String(x.name));
      } finally {
        await pool.close();
      }
    }
    default:
      throw new Error(`unsupported provider: ${p.provider}`);
  }
}

export async function listColumns(p: ConnectionParams, table: string): Promise<ColumnInfo[]> {
  const schema = schemaFor(p);
  switch (p.provider) {
    case 'postgres': {
      const pg = (await import('pg')).default;
      const client = new pg.Client(pgConfig(p));
      await client.connect();
      try {
        const { rows } = await client.query<{ name: string; data_type: string; is_nullable: string }>(
          `SELECT column_name AS name, data_type, is_nullable FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
          [schema, table],
        );
        return rows.map((r) => ({ name: r.name, dataType: r.data_type, nullable: r.is_nullable === 'YES' }));
      } finally {
        await client.end();
      }
    }
    case 'mysql': {
      const mysql = await import('mysql2/promise');
      const conn = await mysql.createConnection(mysqlConfig(p));
      try {
        const [rows] = await conn.query(
          `SELECT column_name AS name, data_type AS dt, is_nullable AS nul FROM information_schema.columns
             WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
          [schema, table],
        );
        return (rows as Record<string, unknown>[]).map((r) => ({
          name: String(r.name ?? r.NAME),
          dataType: String(r.dt ?? r.DT),
          nullable: String(r.nul ?? r.NUL) === 'YES',
        }));
      } finally {
        await conn.end();
      }
    }
    case 'sqlserver': {
      const mssql = (await import('mssql')).default;
      const pool = new mssql.ConnectionPool(mssqlConfig(p));
      await pool.connect();
      try {
        const r = await pool
          .request()
          .input('schema', schema)
          .input('table', table)
          .query(
            `SELECT column_name AS name, data_type AS dt, is_nullable AS nul FROM information_schema.columns
               WHERE table_schema = @schema AND table_name = @table ORDER BY ordinal_position`,
          );
        return (r.recordset as Record<string, unknown>[]).map((x) => ({
          name: String(x.name),
          dataType: String(x.dt),
          nullable: String(x.nul) === 'YES',
        }));
      } finally {
        await pool.close();
      }
    }
    default:
      throw new Error(`unsupported provider: ${p.provider}`);
  }
}

// ── per-driver connection config (matches testConnection.ts) ─────────────────
function pgConfig(p: ConnectionParams) {
  const ssl =
    p.sslMode && p.sslMode !== 'disable' && p.sslMode !== 'prefer'
      ? { rejectUnauthorized: p.sslMode === 'verify-full', servername: p.host }
      : undefined;
  return {
    host: p.connectIp ?? p.host,
    port: p.port,
    database: p.database,
    user: p.username,
    password: p.password,
    ssl,
    connectionTimeoutMillis: p.queryTimeoutS * 1000,
    statement_timeout: p.queryTimeoutS * 1000,
  };
}

function mysqlConfig(p: ConnectionParams) {
  return {
    host: p.connectIp ?? p.host,
    port: p.port,
    database: p.database,
    user: p.username,
    password: p.password,
    connectTimeout: p.queryTimeoutS * 1000,
    ssl: p.sslMode && p.sslMode !== 'disable' ? {} : undefined,
  };
}

function mssqlConfig(p: ConnectionParams) {
  return {
    server: p.connectIp ?? p.host,
    port: p.port,
    database: p.database,
    user: p.username,
    password: p.password,
    connectionTimeout: p.queryTimeoutS * 1000,
    requestTimeout: p.queryTimeoutS * 1000,
    options: {
      encrypt: p.sslMode !== 'disable',
      trustServerCertificate: p.sslMode !== 'verify-full',
      ...(p.connectIp ? { serverName: p.host } : {}),
    },
  };
}
