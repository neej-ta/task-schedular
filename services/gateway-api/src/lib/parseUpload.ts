import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

// ─────────────────────────────────────────────────────────────────────────────
// Parse an uploaded CSV or Excel (.xlsx) file into: detected column headers, a
// small sample of rows (for the mapping UI preview), and a normalized CSV text
// blob. We always store CSV in object storage so the worker's source reader
// stays unchanged (it parses csv | json | xml only).
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedUpload {
  columns: string[];
  sample: Record<string, unknown>[];
  csvText: string;
  rowCount: number;
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const lines = [headers.map(csvEscape).join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvEscape(r[h])).join(','));
  return lines.join('\n');
}

/** ExcelJS cell values can be Dates, formulas, hyperlinks, or rich text. */
function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.text !== undefined) return String(o.text);
    if (o.result !== undefined) return String(o.result);
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join('');
    if (o.hyperlink !== undefined) return String(o.hyperlink);
    return '';
  }
  return String(v);
}

export async function parseUpload(filename: string, buf: Buffer): Promise<ParsedUpload> {
  const lower = filename.toLowerCase();

  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
    const wb = new ExcelJS.Workbook();
    // Cast around the @types/node Buffer-generic vs ExcelJS Buffer mismatch.
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('the Excel file has no worksheets');

    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
      headers[col - 1] = cellToString(cell.value).trim();
    });
    const columns = headers.filter((h) => h && h.length > 0);
    if (columns.length === 0) throw new Error('no header row found in the first sheet');

    const rows: Record<string, unknown>[] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return; // header
      const obj: Record<string, unknown> = {};
      headers.forEach((h, i) => {
        if (h) obj[h] = cellToString(row.getCell(i + 1).value);
      });
      if (Object.values(obj).some((v) => v !== '' && v !== null && v !== undefined)) rows.push(obj);
    });

    return { columns, sample: rows.slice(0, 5), csvText: toCsv(columns, rows), rowCount: rows.length };
  }

  // CSV (default for .csv / .txt / unknown)
  const text = buf.toString('utf8');
  const records = parse(text, { columns: true, skip_empty_lines: true, trim: false, bom: true }) as Record<
    string,
    unknown
  >[];
  const columns = records.length
    ? Object.keys(records[0]!)
    : (text.split(/\r?\n/)[0]?.split(',').map((s) => s.trim()).filter(Boolean) ?? []);
  if (columns.length === 0) throw new Error('no columns detected (is the file empty?)');
  return { columns, sample: records.slice(0, 5), csvText: text, rowCount: records.length };
}
