import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vectors } from '@conductor/rule-conformance';
import { evaluateRow } from './evaluate.js';

// The single TS engine must satisfy every shared conformance vector (spec §20).
for (const v of vectors) {
  test(`conformance: ${v.name}`, () => {
    const result = evaluateRow(v.ruleSet, v.input);

    assert.equal(result.valid, v.expect.valid, `valid mismatch for "${v.name}"`);

    if (v.expect.errorRules) {
      const got = result.errors.map((e) => e.rule).sort();
      assert.deepEqual(got, [...v.expect.errorRules].sort(), `error rules mismatch for "${v.name}"`);
    }

    if (v.expect.value) {
      for (const [k, expected] of Object.entries(v.expect.value)) {
        assert.deepEqual(result.value[k], expected, `value[${k}] mismatch for "${v.name}"`);
      }
    }
  });
}
