import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routingKeyForType, queueForType, IsolationModeSchema } from './common.js';

test('shared tier (no projectId) keeps the pooled keys', () => {
  assert.equal(routingKeyForType('bulk_import'), 'conductor.job.bulk_import');
  assert.equal(queueForType('bulk_import'), 'conductor.q.bulk_import');
  // null is treated the same as omitted
  assert.equal(routingKeyForType('bulk_import', null), 'conductor.job.bulk_import');
  assert.equal(queueForType('bulk_import', null), 'conductor.q.bulk_import');
});

test('dedicated tier suffixes the project id', () => {
  const pid = '11111111-2222-3333-4444-555555555555';
  assert.equal(routingKeyForType('bulk_import', pid), `conductor.job.bulk_import.p.${pid}`);
  assert.equal(queueForType('bulk_import', pid), `conductor.q.bulk_import.p.${pid}`);
});

test('routing key and queue agree on the per-project segment', () => {
  assert.equal(routingKeyForType('rest_pull', 'abc'), 'conductor.job.rest_pull.p.abc');
  assert.equal(queueForType('rest_pull', 'abc'), 'conductor.q.rest_pull.p.abc');
});

test('isolation mode enum accepts the two tiers only', () => {
  assert.equal(IsolationModeSchema.parse('shared'), 'shared');
  assert.equal(IsolationModeSchema.parse('dedicated'), 'dedicated');
  assert.throws(() => IsolationModeSchema.parse('other'));
});
