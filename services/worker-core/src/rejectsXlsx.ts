import ExcelJS from 'exceljs';
import { query } from '@conductor/db';
import { putObject, defaultBucket } from '@conductor/storage';
import type { Row } from '@conductor/rule-engine';

// ─────────────────────────────────────────────────────────────────────────────
// Highlighted Excel rejects export. Writes the WHOLE import file back as an .xlsx
// where every REJECTED row's offending cell(s) are filled red and a trailing
// `_status` / `_reason` pair explains each rejection — so the user opens it in
// Excel, sees exactly which field failed its project rule (e.g. a 10-digit
// rule), fixes those cells, and re-imports (already-imported rows are skipped
// idempotently). Companion to the CSV variant (writeRejectsFile). Provider-
// neutral: it reads job_errors from the control DB + the in-memory source rows,
// so it works identically for any target DB.
// ─────────────────────────────────────────────────────────────────────────────

const RED_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
const GREEN_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } };

// ExcelJS builds the whole workbook in memory, so the highlighted .xlsx is only
// generated up to this row count (the common interactive case). Above it the
// annotated CSV — which streams/concatenates cheaply at any size — is still
// produced, so very large imports never risk OOMing the worker.
const MAX_XLSX_ROWS = Number(process.env.REJECTS_XLSX_MAX ?? 100_000);

/** True if the highlighted Excel was generated; false if skipped (too large). */
export async function writeRejectsXlsx(
  jobId: string,
  records: Row[],
  mapping: Record<string, string>,
): Promise<boolean> {
  if (records.length > MAX_XLSX_ROWS) return false;
  // Per-row failing fields + human reasons. job_errors.field is a SOURCE field
  // for rule/lookup errors and a TARGET column (sometimes comma-joined) for
  // DB-enforced `unique` errors — reverse-map the latter back to source columns
  // so the highlighted cell lines up with what's actually in the file.
  const { rows: errs } = await query<{ row_number: string; field: string | null; message: string }>(
    `SELECT row_number, field, message FROM job_errors WHERE job_id=$1 ORDER BY row_number, id`,
    [jobId],
  );

  const targetToSource: Record<string, string> = {};
  for (const [src, tgt] of Object.entries(mapping)) targetToSource[tgt] = src;
  const sourceCols = records.length ? Object.keys(records[0]!) : Object.keys(mapping);
  const sourceSet = new Set(sourceCols);

  const reasonsByRow = new Map<number, string[]>();
  const failColsByRow = new Map<number, Set<string>>();
  for (const e of errs) {
    const rn = Number(e.row_number);
    (reasonsByRow.get(rn) ?? reasonsByRow.set(rn, []).get(rn)!).push(
      (e.field ? `${e.field}: ` : '') + e.message,
    );
    const set = failColsByRow.get(rn) ?? failColsByRow.set(rn, new Set()).get(rn)!;
    if (e.field) {
      for (const raw of e.field.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (sourceSet.has(raw)) set.add(raw);
        else if (targetToSource[raw] && sourceSet.has(targetToSource[raw])) set.add(targetToSource[raw]!);
      }
    }
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Rows');
  const header = [...sourceCols, '_status', '_reason'];
  ws.addRow(header);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const statusColIdx = sourceCols.length + 1;
  for (let i = 0; i < records.length; i++) {
    const rn = i + 1;
    const rec = records[i] as Row;
    const reasons = reasonsByRow.get(rn);
    const rejected = !!reasons;
    const values = sourceCols.map((c) => (rec[c] ?? '') as ExcelJS.CellValue);
    const row = ws.addRow([...values, rejected ? 'REJECTED' : 'OK', rejected ? reasons!.join('; ') : '']);

    const statusCell = row.getCell(statusColIdx);
    statusCell.fill = rejected ? RED_FILL : GREEN_FILL;
    statusCell.font = { bold: true, color: { argb: rejected ? 'FF9C0006' : 'FF006100' } };

    if (rejected) {
      for (const col of failColsByRow.get(rn) ?? []) {
        const idx = sourceCols.indexOf(col);
        if (idx >= 0) {
          const cell = row.getCell(idx + 1);
          cell.fill = RED_FILL;
          cell.font = { color: { argb: 'FF9C0006' } };
        }
      }
    }
  }

  header.forEach((h, i) => {
    ws.getColumn(i + 1).width = Math.min(48, Math.max(12, h.length + 2));
  });

  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  await putObject(`rejects/${jobId}.xlsx`, buf, defaultBucket());
  return true;
}
