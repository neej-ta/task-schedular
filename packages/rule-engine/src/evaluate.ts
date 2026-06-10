import type { Rule, RuleSet } from '@conductor/contracts';
import type { EvalResult, Row, RowError, StatefulRules } from './types.js';
import { applyTransforms } from './transforms.js';
import { evalExpression } from './expression.js';

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

function defaultMessage(rule: Rule): string {
  return rule.message ?? `failed ${rule.type} on ${rule.field}`;
}

// `unique` and `lookup` are intentionally NOT evaluated here (spec §10 trap):
// uniqueness is enforced by a DB constraint at staging; lookups resolve against
// the target DB. They are surfaced via extractStatefulRules() for the handler.
function checkRule(rule: Rule, row: Row): RowError | null {
  const v = row[rule.field];

  if (rule.type === 'required') {
    return isEmpty(v) ? { field: rule.field, rule: 'required', message: defaultMessage(rule) } : null;
  }

  // Non-required rules are skipped for empty values (only `required` enforces presence).
  if (isEmpty(v)) return null;

  const fail = (): RowError => ({ field: rule.field, rule: rule.type, message: defaultMessage(rule) });

  switch (rule.type) {
    case 'regex':
      if (!rule.pattern) return fail();
      try {
        // A bad pattern is a ruleset config error — surface it as a row error,
        // never let it throw and abort the whole chunk/job.
        return new RegExp(rule.pattern).test(String(v)) ? null : fail();
      } catch {
        return { field: rule.field, rule: 'regex', message: `invalid regex pattern: ${rule.pattern}` };
      }
    case 'range': {
      const n = Number(v);
      if (Number.isNaN(n)) return fail();
      if (rule.min !== undefined && n < rule.min) return fail();
      if (rule.max !== undefined && n > rule.max) return fail();
      return null;
    }
    case 'length': {
      const len = String(v).length;
      if (rule.min !== undefined && len < rule.min) return fail();
      if (rule.max !== undefined && len > rule.max) return fail();
      return null;
    }
    case 'enum':
      return rule.values && rule.values.map(String).includes(String(v)) ? null : fail();
    case 'type': {
      switch (rule.cast) {
        case 'integer':
          return Number.isInteger(Number(v)) ? null : fail();
        case 'number':
          return !Number.isNaN(Number(v)) ? null : fail();
        case 'boolean':
          return ['true', 'false', '0', '1'].includes(String(v).toLowerCase()) ? null : fail();
        case 'date':
          return !Number.isNaN(Date.parse(String(v))) ? null : fail();
        case 'string':
        default:
          return null;
      }
    }
    case 'compare': {
      if (!rule.other) return null;
      const other = row[rule.other];
      const op = rule.op ?? 'eq';
      const a = Number(v);
      const b = Number(other);
      const numeric = !Number.isNaN(a) && !Number.isNaN(b);
      const cmp: Record<string, boolean> = {
        eq: String(v) === String(other),
        ne: String(v) !== String(other),
        lt: numeric && a < b,
        lte: numeric && a <= b,
        gt: numeric && a > b,
        gte: numeric && a >= b,
      };
      return cmp[op] ? null : fail();
    }
    case 'expression':
      try {
        return rule.expr && !!evalExpression(rule.expr, row) ? null : fail();
      } catch {
        return fail();
      }
    case 'unique':
    case 'lookup':
      return null; // handled by the DB, not in-process
    default:
      return null;
  }
}

/** Evaluate one row against a rule set: transforms first, then field-local rules. */
export function evaluateRow(ruleSet: RuleSet, input: Row): EvalResult {
  const value = applyTransforms(input, ruleSet.transforms ?? []);
  const errors: RowError[] = [];
  for (const rule of ruleSet.rules ?? []) {
    const err = checkRule(rule, value);
    if (err) errors.push(err);
  }
  return { valid: errors.length === 0, errors, value };
}

/** Pull out the stateful rules the handler must enforce via the DB. */
export function extractStatefulRules(ruleSet: RuleSet): StatefulRules {
  const uniqueFields: string[] = [];
  const lookups: { field: string; entity: string }[] = [];
  for (const rule of ruleSet.rules ?? []) {
    if (rule.type === 'unique') uniqueFields.push(rule.field);
    if (rule.type === 'lookup' && rule.entity) lookups.push({ field: rule.field, entity: rule.entity });
  }
  return { uniqueFields, lookups };
}
