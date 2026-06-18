/**
 * MySQL execution-path integration test.
 *
 * Proves the @conductor/targetdb MySQL adapter — and therefore every DB job
 * handler that runs through it (bulk_import/insert/update/delete, file_outbound,
 * rest_push) — actually works against a real MySQL instance.
 *
 * Run it against the docker-compose `mysql` profile container:
 *   docker compose --profile mysql up -d mysql        # wait for healthy
 *   npm run itest:mysql
 *
 * Env (defaults match docker-compose.yml):
 *   MYSQL_HOST=127.0.0.1  MYSQL_PORT=3306  MYSQL_USER=demo  MYSQL_PASSWORD=demo_dev_pw
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as mysql from 'mysql2/promise';
import { encryptSecret } from '@conductor/security';
import { getTargetDb, closeAllTargetPools, coerce, type ProjectConn } from '@conductor/targetdb';

process.env.CONDUCTOR_MASTER_KEY ??= 'Y29uZHVjdG9yLWRldi1tYXN0ZXIta2V5LTMyYnl0ZXM=';
process.env.CONDUCTOR_MASTER_KEY_ID ??= 'dev-local-v1';
process.env.SSRF_ALLOWLIST = [process.env.SSRF_ALLOWLIST, '127.0.0.1/32'].filter(Boolean).join(',');

const HOST = process.env.MYSQL_HOST ?? '127.0.0.1';
const PORT = Number(process.env.MYSQL_PORT ?? 3306);
const USER = process.env.MYSQL_USER ?? 'demo';
const PASS = process.env.MYSQL_PASSWORD ?? 'demo_dev_pw';
const DB = 'demo';

const project: ProjectConn = {
  id: 'itest-mysql',
  provider: 'mysql',
  host: HOST,
  port: PORT,
  database: DB,
  schema: null,
  username: USER,
  secret_ciphertext: encryptSecret(PASS),
  ssl_mode: 'disable',
  pool_max: 4,
  query_timeout_s: 30,
  allowlist_hosts: [HOST],
};

/** Create the customers table (idempotent), clean slate each run. */
before(async () => {
  const conn = await mysql.createConnection({ host: HOST, port: PORT, user: USER, password: PASS, database: DB });
  await conn.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id            BIGINT AUTO_INCREMENT PRIMARY KEY,
      customer_name VARCHAR(255),
      email         VARCHAR(255) UNIQUE,
      age           INT,
      country       VARCHAR(100),
      customer_code VARCHAR(100) UNIQUE,
      join_date     DATE,
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted_at    DATETIME NULL
    )`);
  await conn.query('DELETE FROM customers');
  await conn.end();
});

after(async () => {
  await closeAllTargetPools();
});

const TARGET_COLS = ['customer_name', 'email', 'age', 'country', 'customer_code'];
const UNIQUE_COLS = ['email', 'customer_code'];

test('introspectColumns reconstructs DDL-ready types', async () => {
  const db = await getTargetDb(project);
  const cols = await db.introspectColumns(DB, 'customers');
  assert.equal(cols.get('customer_name'), 'varchar(255)');
  assert.equal(cols.get('country'), 'varchar(100)');
  assert.match(String(cols.get('age')), /^int/);
  assert.match(String(cols.get('created_at')), /datetime/);
});

test('bulk_import path: staging insert + idempotent promote', async () => {
  const db = await getTargetDb(project);
  const colTypes = await db.introspectColumns(DB, 'customers');
  const staging = 'conductor_stg_itest1';

  await db.createStaging(DB, staging, TARGET_COLS, colTypes, UNIQUE_COLS);

  const cols = ['row_number', ...TARGET_COLS];
  const prefix = `INSERT INTO ${db.qualify(DB, staging)} (${cols.map((c) => db.ident(c)).join(', ')})`;
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

  const inserted = await db.promote(DB, 'customers', staging, TARGET_COLS, UNIQUE_COLS);
  assert.equal(inserted, 3, 'first promote inserts all 3');

  const again = await db.promote(DB, 'customers', staging, TARGET_COLS, UNIQUE_COLS);
  assert.equal(again, 0, 'second promote is idempotent (no duplicates)');

  const { rows } = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM customers');
  assert.equal(Number(rows[0]!.n), 3);

  await db.dropStagingIfExists(DB, staging);
});

test('existsOne + bulk_update path (UPDATE … = ? , now())', async () => {
  const db = await getTargetDb(project);
  const tbl = db.qualify(DB, 'customers');

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
  const tbl = db.qualify(DB, 'customers');

  const soft = await db.query(
    `UPDATE ${tbl} SET ${db.ident('deleted_at')} = ${db.now()} WHERE ${db.ident('customer_code')} = ? AND ${db.ident('deleted_at')} IS NULL`,
    ['C002'],
  );
  assert.equal(soft.rowCount, 1);
  const live = `${db.ident('customer_code')} = ? AND ${db.ident('deleted_at')} IS NULL`;
  assert.equal(await db.existsOne(tbl, live, ['C002']), false);

  const hard = await db.query(`DELETE FROM ${tbl} WHERE ${db.ident('customer_code')} = ?`, ['C003']);
  assert.equal(hard.rowCount, 1);
});

test('error classification against the real engine', async () => {
  const db = await getTargetDb(project);
  const tbl = db.qualify(DB, 'customers');

  // duplicate unique key → ER_DUP_ENTRY (1062)
  let uniqueErr: unknown;
  try {
    await db.query(`INSERT INTO ${tbl} (${db.ident('email')}) VALUES (?)`, ['alice@x.com']);
  } catch (e) {
    uniqueErr = e;
  }
  assert.ok(uniqueErr, 'expected a duplicate-key error');
  assert.equal(db.isUniqueViolation(uniqueErr), true);
  assert.equal(db.isDataError(uniqueErr), false);

  // non-numeric value into an int column → wrong-value data error (1366, strict mode)
  let dataErr: unknown;
  try {
    await db.query(`INSERT INTO ${tbl} (${db.ident('email')}, ${db.ident('age')}) VALUES (?, ?)`, [
      'dave@x.com',
      'not-a-number',
    ]);
  } catch (e) {
    dataErr = e;
  }
  assert.ok(dataErr, 'expected a wrong-value error');
  assert.equal(db.isDataError(dataErr), true);
  assert.equal(db.isUniqueViolation(dataErr), false);
});

test('deleteStagingRows removes only the listed rows', async () => {
  const db = await getTargetDb(project);
  const colTypes = await db.introspectColumns(DB, 'customers');
  const staging = 'conductor_stg_itest2';
  await db.createStaging(DB, staging, TARGET_COLS, colTypes, UNIQUE_COLS);

  const cols = ['row_number', ...TARGET_COLS];
  const prefix = `INSERT INTO ${db.qualify(DB, staging)} (${cols.map((c) => db.ident(c)).join(', ')})`;
  for (const [rn, code] of [[10, 'X1'], [11, 'X2'], [12, 'X3']] as [number, string][]) {
    await db.query(`${prefix} VALUES (?, ?, ?, ?, ?, ?)`, [rn, `n${rn}`, `e${rn}@x.com`, 20, 'US', code]);
  }
  await db.deleteStagingRows(DB, staging, [11]);
  const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${db.qualify(DB, staging)}`);
  assert.equal(Number(rows[0]!.n), 2);

  await db.dropStagingIfExists(DB, staging);
});
