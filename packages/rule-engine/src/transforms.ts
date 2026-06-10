import type { Transform } from '@conductor/contracts';
import type { Row } from './types.js';
import { evalExpression } from './expression.js';

// ── Date parsing for the `dateFormat` transform ──────────────────────────────
// Supports tokens yyyy, MM, dd, HH, mm, ss with any single-char separators.
// Converts `from` → ISO-8601 (date-only if no time tokens). Deterministic.

function parseWithFormat(value: string, fmt: string): string | null {
  const tokens = fmt.match(/yyyy|MM|dd|HH|mm|ss/g);
  if (!tokens) return null;
  // Build a regex from the format, escaping separators.
  const pattern = fmt.replace(/yyyy|MM|dd|HH|mm|ss|[^a-zA-Z]/g, (m) => {
    switch (m) {
      case 'yyyy':
        return '(\\d{4})';
      case 'MM':
      case 'dd':
      case 'HH':
      case 'mm':
      case 'ss':
        return '(\\d{1,2})';
      default:
        return m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  });
  const m = new RegExp(`^${pattern}$`).exec(value.trim());
  if (!m) return null;
  const parts: Record<string, number> = {};
  tokens.forEach((tok, idx) => {
    parts[tok] = Number(m[idx + 1]);
  });
  const yyyy = parts.yyyy ?? 1970;
  const MM = parts.MM ?? 1;
  const dd = parts.dd ?? 1;
  const HH = parts.HH ?? 0;
  const mm = parts.mm ?? 0;
  const ss = parts.ss ?? 0;
  const p2 = (n: number) => String(n).padStart(2, '0');
  const hasTime = 'HH' in parts || 'mm' in parts || 'ss' in parts;
  return hasTime
    ? `${yyyy}-${p2(MM)}-${p2(dd)}T${p2(HH)}:${p2(mm)}:${p2(ss)}Z`
    : `${yyyy}-${p2(MM)}-${p2(dd)}`;
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

/** Apply a single transform to a copy of the row, returning the new row. */
export function applyTransform(row: Row, t: Transform): Row {
  const out = { ...row };
  const v = out[t.field];
  switch (t.op) {
    case 'trim':
      if (typeof v === 'string') out[t.field] = v.trim();
      break;
    case 'upper':
      if (typeof v === 'string') out[t.field] = v.toUpperCase();
      break;
    case 'lower':
      if (typeof v === 'string') out[t.field] = v.toLowerCase();
      break;
    case 'dateFormat':
      if (typeof v === 'string' && t.from && t.to === 'iso') {
        const iso = parseWithFormat(v, t.from);
        if (iso) out[t.field] = iso;
      }
      break;
    case 'map':
      if (t.map && String(v) in t.map) out[t.field] = t.map[String(v)];
      break;
    case 'default':
      if (isEmpty(v)) out[t.field] = t.value;
      break;
    case 'computed':
      if (t.expr) out[t.field] = evalExpression(t.expr, out);
      break;
  }
  return out;
}

export function applyTransforms(row: Row, transforms: Transform[]): Row {
  return transforms.reduce(applyTransform, row);
}
