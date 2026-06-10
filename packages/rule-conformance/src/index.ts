import type { RuleSet } from '@conductor/contracts';

// ─────────────────────────────────────────────────────────────────────────────
// Shared rule-engine conformance vectors (spec §6, §20). Any rule-engine
// implementation MUST produce identical results for these. Run by the
// rule-engine test suite; CI gates on it.
// ─────────────────────────────────────────────────────────────────────────────

export interface Vector {
  name: string;
  ruleSet: RuleSet;
  input: Record<string, unknown>;
  expect: {
    valid: boolean;
    /** Sorted list of rule types expected to fail (when valid === false). */
    errorRules?: string[];
    /** Optional expected values after transforms (checked key-by-key). */
    value?: Record<string, unknown>;
  };
}

const rs = (rules: RuleSet['rules'], transforms: RuleSet['transforms'] = []): RuleSet => ({
  ruleSetId: 'conformance@v1',
  rules,
  transforms,
});

export const vectors: Vector[] = [
  // ── required ──
  {
    name: 'required: present passes',
    ruleSet: rs([{ field: 'Email', type: 'required' }]),
    input: { Email: 'a@b.com' },
    expect: { valid: true },
  },
  {
    name: 'required: empty string fails',
    ruleSet: rs([{ field: 'Email', type: 'required' }]),
    input: { Email: '' },
    expect: { valid: false, errorRules: ['required'] },
  },
  {
    name: 'required: missing key fails',
    ruleSet: rs([{ field: 'Email', type: 'required' }]),
    input: {},
    expect: { valid: false, errorRules: ['required'] },
  },
  // ── regex ──
  {
    name: 'regex: matches',
    ruleSet: rs([{ field: 'Email', type: 'regex', pattern: '^[^@]+@[^@]+$' }]),
    input: { Email: 'a@b.com' },
    expect: { valid: true },
  },
  {
    name: 'regex: no match fails',
    ruleSet: rs([{ field: 'Email', type: 'regex', pattern: '^[^@]+@[^@]+$' }]),
    input: { Email: 'not-an-email' },
    expect: { valid: false, errorRules: ['regex'] },
  },
  {
    name: 'regex: skipped when empty and not required',
    ruleSet: rs([{ field: 'Email', type: 'regex', pattern: '^x$' }]),
    input: { Email: '' },
    expect: { valid: true },
  },
  // ── range ──
  {
    name: 'range: within min passes',
    ruleSet: rs([{ field: 'Age', type: 'range', min: 18 }]),
    input: { Age: '21' },
    expect: { valid: true },
  },
  {
    name: 'range: below min fails',
    ruleSet: rs([{ field: 'Age', type: 'range', min: 18 }]),
    input: { Age: '16' },
    expect: { valid: false, errorRules: ['range'] },
  },
  // ── length ──
  {
    name: 'length: max enforced',
    ruleSet: rs([{ field: 'Code', type: 'length', max: 3 }]),
    input: { Code: 'ABCD' },
    expect: { valid: false, errorRules: ['length'] },
  },
  // ── enum ──
  {
    name: 'enum: member passes',
    ruleSet: rs([{ field: 'Country', type: 'enum', values: ['US', 'UK', 'IN'] }]),
    input: { Country: 'UK' },
    expect: { valid: true },
  },
  {
    name: 'enum: non-member fails',
    ruleSet: rs([{ field: 'Country', type: 'enum', values: ['US', 'UK', 'IN'] }]),
    input: { Country: 'FR' },
    expect: { valid: false, errorRules: ['enum'] },
  },
  // ── type/cast ──
  {
    name: 'type integer: non-integer fails',
    ruleSet: rs([{ field: 'Age', type: 'type', cast: 'integer' }]),
    input: { Age: '3.5' },
    expect: { valid: false, errorRules: ['type'] },
  },
  {
    name: 'type date: parseable passes',
    ruleSet: rs([{ field: 'JoinDate', type: 'type', cast: 'date' }]),
    input: { JoinDate: '2026-01-02' },
    expect: { valid: true },
  },
  // ── compare ──
  {
    name: 'compare gte: passes',
    ruleSet: rs([{ field: 'End', type: 'compare', op: 'gte', other: 'Start' }]),
    input: { Start: '5', End: '9' },
    expect: { valid: true },
  },
  {
    name: 'compare gte: fails',
    ruleSet: rs([{ field: 'End', type: 'compare', op: 'gte', other: 'Start' }]),
    input: { Start: '9', End: '5' },
    expect: { valid: false, errorRules: ['compare'] },
  },
  // ── expression ──
  {
    name: 'expression: boolean logic passes',
    ruleSet: rs([{ field: 'Age', type: 'expression', expr: 'Age >= 18 && Country == "US"' }]),
    input: { Age: '20', Country: 'US' },
    expect: { valid: true },
  },
  {
    name: 'expression: fails',
    ruleSet: rs([{ field: 'Age', type: 'expression', expr: 'Age >= 18 && Country == "US"' }]),
    input: { Age: '20', Country: 'FR' },
    expect: { valid: false, errorRules: ['expression'] },
  },
  // ── transforms ──
  {
    name: 'transforms: trim + lower applied before rules',
    ruleSet: rs(
      [{ field: 'Email', type: 'regex', pattern: '^[a-z@.]+$' }],
      [
        { field: 'Email', op: 'trim' },
        { field: 'Email', op: 'lower' },
      ],
    ),
    input: { Email: '  A@B.COM  ' },
    expect: { valid: true, value: { Email: 'a@b.com' } },
  },
  {
    name: 'transform: dateFormat MM/dd/yyyy → iso',
    ruleSet: rs([], [{ field: 'JoinDate', op: 'dateFormat', from: 'MM/dd/yyyy', to: 'iso' }]),
    input: { JoinDate: '01/02/2026' },
    expect: { valid: true, value: { JoinDate: '2026-01-02' } },
  },
  {
    name: 'transform: default fills empty',
    ruleSet: rs([], [{ field: 'Country', op: 'default', value: 'US' }]),
    input: { Country: '' },
    expect: { valid: true, value: { Country: 'US' } },
  },
  {
    name: 'transform: map remaps value',
    ruleSet: rs([], [{ field: 'Country', op: 'map', map: { USA: 'US', 'United Kingdom': 'UK' } }]),
    input: { Country: 'USA' },
    expect: { valid: true, value: { Country: 'US' } },
  },
  // ── stateful rules are NOT evaluated in-process ──
  {
    name: 'unique: ignored in-process (DB-enforced) → valid',
    ruleSet: rs([{ field: 'Code', type: 'unique', scope: 'table' }]),
    input: { Code: 'anything' },
    expect: { valid: true },
  },
  {
    name: 'lookup: ignored in-process (DB-enforced) → valid',
    ruleSet: rs([{ field: 'ManagerId', type: 'lookup', entity: 'Employee' }]),
    input: { ManagerId: '42' },
    expect: { valid: true },
  },
  // ── combined: multiple failures collected ──
  {
    name: 'multiple rule failures collected',
    ruleSet: rs([
      { field: 'Email', type: 'required' },
      { field: 'Age', type: 'range', min: 18 },
      { field: 'Country', type: 'enum', values: ['US'] },
    ]),
    input: { Email: '', Age: '10', Country: 'FR' },
    expect: { valid: false, errorRules: ['enum', 'range', 'required'] },
  },
];
