import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresTargetDb } from './postgres.js';
import { SqlServerTargetDb } from './sqlserver.js';
import { MySqlTargetDb } from './mysql.js';
import { coerce } from './types.js';

// Pure dialect logic — no live connection needed (the pool is never touched by
// these methods). The wire-level behavior is covered by the *.itest.ts scripts.
const pg = new PostgresTargetDb({} as never);
const ms = new SqlServerTargetDb({} as never);
const my = new MySqlTargetDb({} as never, 'demo');

test('identifier quoting differs per dialect', () => {
  assert.equal(pg.ident('email'), '"email"');
  assert.equal(ms.ident('email'), '[email]');
  assert.equal(my.ident('email'), '`email`');
  assert.equal(pg.qualify('public', 'customers'), '"public"."customers"');
  assert.equal(ms.qualify('dbo', 'customers'), '[dbo].[customers]');
  assert.equal(my.qualify('demo', 'customers'), '`customers`'); // MySQL: schema == bound database
});

test('unsafe identifiers are rejected (injection guard)', () => {
  for (const db of [pg, ms, my]) {
    assert.throws(() => db.ident('a; DROP TABLE x'));
    assert.throws(() => db.ident('a"b'));
    assert.throws(() => db.ident('1col'));
  }
});

test('now() / castText() use the right dialect syntax', () => {
  assert.equal(pg.now(), 'now()');
  assert.equal(ms.now(), 'SYSUTCDATETIME()');
  assert.equal(my.now(), 'NOW()');
  assert.equal(pg.castText('s."x"'), '(s."x")::text');
  assert.equal(ms.castText('s.[x]'), 'CAST(s.[x] AS NVARCHAR(MAX))');
  assert.equal(my.castText('s.`x`'), 'CAST(s.`x` AS CHAR)');
});

test('bind-param limits reflect the engine', () => {
  assert.equal(pg.maxBindParams, 65535);
  assert.equal(ms.maxBindParams, 2000);
  assert.equal(my.maxBindParams, 65535);
});

test('unique-violation classification', () => {
  assert.equal(pg.isUniqueViolation({ code: '23505' }), true);
  assert.equal(pg.isUniqueViolation({ code: '22001' }), false);
  assert.equal(ms.isUniqueViolation({ number: 2627 }), true);
  assert.equal(ms.isUniqueViolation({ number: 2601 }), true);
  assert.equal(ms.isUniqueViolation({ number: 8152 }), false);
  assert.equal(my.isUniqueViolation({ errno: 1062 }), true); // ER_DUP_ENTRY
  assert.equal(my.isUniqueViolation({ errno: 1366 }), false);
});

test('data-error classification', () => {
  assert.equal(pg.isDataError({ code: '22007' }), true); // invalid datetime
  assert.equal(pg.isDataError({ code: '23502' }), true); // not-null violation
  assert.equal(pg.isDataError({ code: '42703' }), false); // undefined column (fatal)
  assert.equal(ms.isDataError({ number: 245 }), true); // conversion failed
  assert.equal(ms.isDataError({ number: 515 }), true); // null into not-null
  assert.equal(ms.isDataError({ number: 208 }), false); // invalid object (fatal)
  assert.equal(my.isDataError({ errno: 1366 }), true); // wrong value for column
  assert.equal(my.isDataError({ errno: 1048 }), true); // null into not-null
  assert.equal(my.isDataError({ errno: 1146 }), false); // table doesn't exist (fatal)
});

test('coerce handles both PostgreSQL and SQL Server type names', () => {
  // integers
  assert.equal(coerce('42', 'integer'), 42);
  assert.equal(coerce('42', 'int'), 42);
  assert.equal(coerce('42', 'bigint'), 42);
  assert.equal(coerce('1.9', 'int'), 1); // truncated
  assert.equal(coerce('abc', 'int'), null); // non-numeric → null
  // decimals
  assert.equal(coerce('3.14', 'numeric'), 3.14);
  assert.equal(coerce('3.14', 'decimal(10,2)'), 3.14);
  assert.equal(coerce('3.14', 'money'), 3.14);
  // booleans
  assert.equal(coerce('true', 'boolean'), true);
  assert.equal(coerce('1', 'bit'), true);
  assert.equal(coerce('no', 'bit'), false);
  // strings / passthrough
  assert.equal(coerce('hello', 'nvarchar(255)'), 'hello');
  assert.equal(coerce('2024-01-01', 'date'), '2024-01-01');
  // empties → null
  assert.equal(coerce('', 'int'), null);
  assert.equal(coerce(null, 'nvarchar(255)'), null);
});
