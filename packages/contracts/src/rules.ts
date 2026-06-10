import { z } from 'zod';

// ── Rule schema (spec §10). One declarative format, evaluated in-process. ──────

export const RuleTypeSchema = z.enum([
  'required',
  'regex',
  'range',
  'length',
  'enum',
  'type', // type/cast
  'unique',
  'lookup',
  'compare',
  'expression',
]);
export type RuleType = z.infer<typeof RuleTypeSchema>;

export const RuleSchema = z
  .object({
    field: z.string().min(1),
    type: RuleTypeSchema,
    // Type-specific params kept permissive here; the evaluator validates per type.
    pattern: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    values: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    // 'unique' scope: where uniqueness is enforced (a DB constraint backs this).
    scope: z.enum(['table', 'batch']).optional(),
    // 'lookup' target entity resolved against the target DB.
    entity: z.string().optional(),
    // 'type' cast target.
    cast: z.enum(['string', 'number', 'integer', 'boolean', 'date']).optional(),
    // 'compare' operands.
    op: z.string().optional(),
    other: z.string().optional(),
    // 'expression' body.
    expr: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();
export type Rule = z.infer<typeof RuleSchema>;

export const TransformSchema = z
  .object({
    field: z.string().min(1),
    op: z.enum(['trim', 'upper', 'lower', 'dateFormat', 'map', 'default', 'computed']),
    from: z.string().optional(),
    to: z.string().optional(),
    map: z.record(z.string(), z.unknown()).optional(),
    value: z.unknown().optional(), // for 'default'
    expr: z.string().optional(), // for 'computed'
  })
  .strict();
export type Transform = z.infer<typeof TransformSchema>;

export const RuleSetSchema = z.object({
  ruleSetId: z.string(),
  rules: z.array(RuleSchema).default([]),
  transforms: z.array(TransformSchema).default([]),
});
export type RuleSet = z.infer<typeof RuleSetSchema>;
