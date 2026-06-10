import type { Provider } from '@conductor/contracts';

export interface ConnectionParams {
  provider: Provider;
  host: string;
  port: number;
  database: string;
  schema?: string | null;
  username: string;
  password: string; // decrypted in-memory only
  sslMode?: string;
  queryTimeoutS: number;
  /**
   * The pre-validated IP to actually connect to (spec §7 anti-DNS-rebinding).
   * When set, the driver connects to this IP instead of re-resolving `host`,
   * and `host` is used only as the TLS servername. Defeats TOCTOU rebinding.
   */
  connectIp?: string;
}

export interface TestConnectionResult {
  ok: boolean;
  latencyMs: number;
  serverVersion?: string;
  error?: string;
}

/**
 * Open a short-lived connection to a target project DB, run `SELECT 1`, and
 * report latency. Never returns or logs the secret. Parameterized queries only.
 */
export async function testConnection(p: ConnectionParams): Promise<TestConnectionResult> {
  const started = process.hrtime.bigint();
  try {
    switch (p.provider) {
      case 'postgres':
        await testPostgres(p);
        break;
      case 'mysql':
        await testMysql(p);
        break;
      case 'sqlserver':
        await testSqlServer(p);
        break;
      default:
        return { ok: false, latencyMs: 0, error: `unsupported provider: ${p.provider}` };
    }
    const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
    return { ok: true, latencyMs: Math.round(latencyMs * 100) / 100 };
  } catch (err) {
    const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
    return { ok: false, latencyMs: Math.round(latencyMs), error: (err as Error).message };
  }
}

async function testPostgres(p: ConnectionParams): Promise<void> {
  const pg = (await import('pg')).default;
  const ssl =
    p.sslMode && p.sslMode !== 'disable' && p.sslMode !== 'prefer'
      ? { rejectUnauthorized: p.sslMode === 'verify-full', servername: p.host }
      : undefined;
  const client = new pg.Client({
    host: p.connectIp ?? p.host, // connect to the validated IP, not a re-resolution
    port: p.port,
    database: p.database,
    user: p.username,
    password: p.password,
    ssl,
    connectionTimeoutMillis: p.queryTimeoutS * 1000,
    statement_timeout: p.queryTimeoutS * 1000,
  });
  await client.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    await client.end();
  }
}

async function testMysql(p: ConnectionParams): Promise<void> {
  const mysql = await import('mysql2/promise');
  const conn = await mysql.createConnection({
    host: p.connectIp ?? p.host, // validated IP
    port: p.port,
    database: p.database,
    user: p.username,
    password: p.password,
    connectTimeout: p.queryTimeoutS * 1000,
    ssl: p.sslMode && p.sslMode !== 'disable' ? {} : undefined,
  });
  try {
    await conn.query('SELECT 1');
  } finally {
    await conn.end();
  }
}

async function testSqlServer(p: ConnectionParams): Promise<void> {
  const mssql = (await import('mssql')).default;
  const pool = new mssql.ConnectionPool({
    server: p.connectIp ?? p.host, // validated IP
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
  });
  await pool.connect();
  try {
    await pool.request().query('SELECT 1');
  } finally {
    await pool.close();
  }
}
