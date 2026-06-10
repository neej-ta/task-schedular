export type Row = Record<string, unknown>;

export interface RowError {
  field?: string;
  rule: string;
  message: string;
}

export interface EvalResult {
  valid: boolean;
  errors: RowError[];
  /** The transformed row (transforms applied), ready for staging. */
  value: Row;
}

/** Stateful rules are NOT evaluated in-process (spec §10 trap). */
export interface StatefulRules {
  /** Fields that must be unique — enforced by a DB constraint at staging. */
  uniqueFields: string[];
  /** Lookups resolved against the target DB during validation. */
  lookups: { field: string; entity: string }[];
}
