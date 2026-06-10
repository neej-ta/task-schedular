// Serialization helpers for file_outbound and row mapping for rest_push.

/** Map a target-DB row (keyed by target column) → source-field-keyed object. */
export function rowToSource(row: Record<string, unknown>, mapping: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [sourceField, targetCol] of Object.entries(mapping)) out[sourceField] = row[targetCol];
  return out;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize rows to CSV with source-field headers (round-trip friendly). */
export function toCsv(rows: Record<string, unknown>[], mapping: Record<string, string>): string {
  const sourceFields = Object.keys(mapping);
  const header = sourceFields.map(csvCell).join(',');
  const body = rows
    .map((r) => sourceFields.map((sf) => csvCell(r[mapping[sf]!])).join(','))
    .join('\n');
  return `${header}\n${body}\n`;
}

export function toJson(rows: Record<string, unknown>[], mapping: Record<string, string>): string {
  return JSON.stringify(rows.map((r) => rowToSource(r, mapping)));
}
