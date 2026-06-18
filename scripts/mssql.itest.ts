/**
 * SQL Server execution-path integration test.
 *
 * Proves the @conductor/targetdb SQL Server adapter — and therefore every DB job
 * handler that runs through it (bulk_import/insert/update/delete, file_outbound,
 * rest_push) — actually works against a real SQL Server instance.
 *
 * Run it against the docker-compose `mssql` profile container:
 *   docker compose --profile mssql up -d sqlserver      # wait for healthy
 *   npm run itest:mssql
 *
 * Env (defaults match docker-compose.yml):
 *   MSSQL_HOST=127.0.0.1  MSSQL_PORT=1433  MSSQL_SA_PASSWORD=Conductor_dev_pw1
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import mssql from 'mssql';
import { encryptSecret } from '@conductor/security';
import { getTargetDb, closeAllTargetPools, coerce, type ProjectConn } from '@conductor/targetdb';

// Master key + SSRF allow-list so the adapter's connect path (decrypt + SSRF
// validation) runs end-to-end exactly as it does in the worker. The crypto and
// SSRF modules read these lazily, so setting them here (after imports) is fine.
process.env.CONDUCTOR_MASTER_KEY ??= 'Y29uZHVjdG9yLWRldi1tYXN0ZXIta2V5LTMyYnl0ZXM=';
process.env.CONDUCTOR_MASTER_KEY_ID ??= 'dev-local-v1';
process.env.SSRF_ALLOWLIST = [process.env.SSRF_ALLOWLIST, '127.0.0.1/32'].filter(Boolean).join(',');

const HOST = process.env.MSSQL_HOST ?? '127.0.0.1';
const PORT = Number(process.env.MSSQL_PORT ?? 1433);
const SA = process.env.MSSQL_SA_PASSWORD ?? 'Conductor_dev_pw1';
const SCHEMA = 'dbo';

const project: ProjectConn = {
  id: 'itest-mssql',
  provider: 'sqlserver',
  host: HOST,
  port: PORT,
  database: 'demo',
  schema: SCHEMA,
  username: 'sa',
  secret_ciphertext: encryptSecret(SA),
  ssl_mode: 'disable',
  pool_max: 4,
  query_timeout_s: 30,
  allowlist_hosts: [HOST],
};

function rawConfig(database: string): mssql.config {
  return {
    server: HOST,
    port: PORT,
    user: 'sa',
    password: SA,
    database,
    connectionTimeout: 30_000,
    requestTimeout: 30_000,
    options: { encrypt: false, trustServerCertificate: true },
  };
}

/** Create the demo DB + customers table (idempotent), clean slate each run. */
before(async () => {
  const master = await new mssql.ConnectionPool(rawConfig('master')).connect();
  await master.request().query("IF DB_ID('demo') IS NULL CREATE DATABASE demo;");
  await master.close();

  const demo = await new mssql.ConnectionPool(rawConfig('demo')).connect();
  await demo.request().query(`
    IF OBJECT_ID('dbo.customers','U') IS NULL
      CREATE TABLE dbo.customers (
        id            INT IDENTITY(1,1) PRIMARY KEY,
        customer_name NVARCHAR(255),
        email         NVARCHAR(255) UNIQUE,
        age           INT,
        country       NVARCHAR(100),
        customer_code NVARCHAR(100) UNIQUE,
        join_date     DATE,
        created_at    DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        updated_at    DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
        deleted_at    DATETIME2 NULL
      );`);
  await demo.request().query('DELETE FROM dbo.customers;');
  await demo.close();
});

after(async () => {
  await closeAllTargetPools();
});

const TARGET_COLS = ['customer_name', 'email', 'age', 'country', 'customer_code'];
const UNIQUE_COLS = ['email', 'customer_code'];

test('introspectColumns reconstructs DDL-ready types', async () => {
  const db = await getTargetDb(project);
  const cols = await db.introspectColumns(SCHEMA, 'customers');
  assert.equal(cols.get('customer_name'), 'nvarchar(255)');
  assert.equal(cols.get('country'), 'nvarchar(100)');
  assert.equal(cols.get('age'), 'int');
  assert.match(String(cols.get('created_at')), /datetime2/);
});

test('bulk_import path: staging insert + idempotent promote', async () => {
  const db = await getTargetDb(project);
  const colTypes = await db.introspectColumns(SCHEMA, 'customers');
  const staging = 'conductor_stg_itest1';

  await db.createStaging(SCHEMA, staging, TARGET_COLS, colTypes, UNIQUE_COLS);

  // Mirror the handler's chunked multi-row INSERT with `?` placeholders.
  const cols = ['row_number', ...TARGET_COLS];
  const prefix = `INSERT INTO ${db.qualify(SCHEMA, staging)} (${cols.map((c) => db.ident(c)).join(', ')})`;
  const source = [
    [1, 'Alice', 'alice@x.com', '30', 'US', 'C001'],
    [2, 'Bob', 'bob@x.com', '', 'UK', 'C002'], // empty age → null
    [3, 'Carol', 'carol@x.com', '41', 'IN', 'C003'],
  ];
  const params: unknown[] = [];
  const tuples = source.map((r) => {
    r.forEach((v, i) => params.push(i === 0 ? v : coerce(v, colTypes.get(cols[i]!))));
    return `(${r.map(() => '?').join(',')})`;
  });
  await db.query(`${prefix} VALUES ${tuples.join(',')}`, params);

  const inserted = await db.promote(SCHEMA, 'customers', staging, TARGET_COLS, UNIQUE_COLS);
  assert.equal(inserted, 3, 'first promote inserts all 3');

  const again = await db.promote(SCHEMA, 'customers', staging, TARGET_COLS, UNIQUE_COLS);
  assert.equal(again, 0, 'second promote is idempotent (no duplicates)');

  const { rows } = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM dbo.customers');
  assert.equal(Number(rows[0]!.n), 3);

  await db.dropStagingIfExists(SCHEMA, staging);
});

test('existsOne + bulk_update path (UPDATE … = ? , now())', async () => {
  const db = await getTargetDb(project);
  const tbl = db.qualify(SCHEMA, 'customers');

  assert.equal(await db.existsOne(tbl, `${db.ident('email')} = ?`, ['alice@x.com']), true);
  assert.equal(await db.existsOne(tbl, `${db.ident('email')} = ?`, ['nobody@x.com']), false);

  const res = await db.query(
    `UPDATE ${tbl} SET ${db.ident('country')} = ?, ${db.ident('updated_at')} = ${db.now()} WHERE ${db.ident('email')} = ?`,
    ['CA', 'alice@x.com'],
  );
  assert.equal(res.rowCount, 1);

  const { rows } = await db.query<{ country: string }>(
    `SELECT ${db.ident('country')} AS country FROM ${tbl} WHERE ${db.ident('email')} = ?`,
    ['alice@x.com'],
  );
  assert.equal(rows[0]!.country, 'CA');
});

test('bulk_delete path: soft-delete then hard-delete', async () => {
  const db = await getTargetDb(project);
  const tbl = db.qualify(SCHEMA, 'customers');

  // soft-delete Bob
  const soft = await db.query(
    `UPDATE ${tbl} SET ${db.ident('deleted_at')} = ${db.now()} WHERE ${db.ident('customer_code')} = ? AND ${db.ident('deleted_at')} IS NULL`,
    ['C002'],
  );
  assert.equal(soft.rowCount, 1);
  // a "live" existence check no longer finds him
  const live = `${db.ident('customer_code')} = ? AND ${db.ident('deleted_at')} IS NULL`;
  assert.equal(await db.existsOne(tbl, live, ['C002']), false);

  // hard-delete Carol
  const hard = await db.query(`DELETE FROM ${tbl} WHERE ${db.ident('customer_code')} = ?`, ['C003']);
  assert.equal(hard.rowCount, 1);
});

test('error classification against the real engine', async () => {
  const db = await getTargetDb(project);
  const tbl = db.qualify(SCHEMA, 'customers');

  // duplicate unique key → unique violation (2627/2601)
  let uniqueErr: unknown;
  try {
    await db.query(`INSERT INTO ${tbl} (${db.ident('email')}) VALUES (?)`, ['alice@x.com']);
  } catch (e) {
    uniqueErr = e;
  }
  assert.ok(uniqueErr, 'expected a duplicate-key error');
  assert.equal(db.isUniqueViolation(uniqueErr), true);
  assert.equal(db.isDataError(uniqueErr), false);

  // non-numeric value into an int column → conversion data error (245)
  let dataErr: unknown;
  try {
    await db.query(`INSERT INTO ${tbl} (${db.ident('email')}, ${db.ident('age')}) VALUES (?, ?)`, [
      'dave@x.com',
      'not-a-number',
    ]);
  } catch (e) {
    dataErr = e;
  }
  assert.ok(dataErr, 'expected a conversion error');
  assert.equal(db.isDataError(dataErr), true);
  assert.equal(db.isUniqueViolation(dataErr), false);
});

test('deleteStagingRows removes only the listed rows', async () => {
  const db = await getTargetDb(project);
  const colTypes = await db.introspectColumns(SCHEMA, 'customers');
  const staging = 'conductor_stg_itest2';
  await db.createStaging(SCHEMA, staging, TARGET_COLS, colTypes, UNIQUE_COLS);

  const cols = ['row_number', ...TARGET_COLS];
  const prefix = `INSERT INTO ${db.qualify(SCHEMA, staging)} (${cols.map((c) => db.ident(c)).join(', ')})`;
  for (const [rn, code] of [[10, 'X1'], [11, 'X2'], [12, 'X3']] as [number, string][]) {
    await db.query(`${prefix} VALUES (?, ?, ?, ?, ?, ?)`, [rn, `n${rn}`, `e${rn}@x.com`, 20, 'US', code]);
  }
  await db.deleteStagingRows(SCHEMA, staging, [11]);
  const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${db.qualify(SCHEMA, staging)}`);
  assert.equal(Number(rows[0]!.n), 2);

  await db.dropStagingIfExists(SCHEMA, staging);
});
