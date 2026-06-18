import { query } from '@conductor/db';
import { evaluateRow, extractStatefulRules, type Row } from '@conductor/rule-engine';
import { getTargetDb, type TargetDb, coerce } from '@conductor/targetdb';
import { isCancelled } from '@conductor/realtime';
import { putObject, defaultBucket } from '@conductor/storage';
import { report, JobCancelled, type JobContext } from '@conductor/worker-runtime';
import { readRows } from '../source.js';
import { config } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared import pipeline (spec §11) for bulk_import / bulk_insert / xml_integration:
//   read (csv|json|xml) → map → validate (in-process rules) → transform →
//   STAGING table → promote (idempotent, dialect-specific).
// Uniqueness is DB-enforced on staging; concurrent chunks race the DB, not app
// code (spec §5.5, §13). Re-runs/redeliveries never duplicate (idempotent promote).
// Provider-neutral (PostgreSQL / SQL Server) via the @conductor/targetdb dialect
// API; the CONTROL-plane queries (job_errors, project_entities, rejects file)
// always run against Conductor's own PostgreSQL via @conductor/db.
// ─────────────────────────────────────────────────────────────────────────────

export async function bulkImport(ctx: JobContext): Promise<void> {
  const { envelope, job, project, entity, ruleSet } = ctx;
  const jobId = job.id;
  const opts = envelope.options;
  const dryRun = opts.dryRun;

  await report.log(jobId, 'info', `reading source (${envelope.source.kind})`);
  const records = await readRows(ctx);
  const totalRows = records.length;

  const mapping = entity.mapping;
  const sourceFields = Object.keys(mapping);
  const targetCols = sourceFields.map((f) => mapping[f]!);

  const { uniqueFields, lookups } = extractStatefulRules(ruleSet);
  const uniqueTargetCols = uniqueFields.map((f) => mapping[f]).filter(Boolean) as string[];

  const db = await getTargetDb(project);
  const schema = project.schema || 'public';
  const colTypes = await db.introspectColumns(schema, entity.targetTable);

  const staging = `conductor_stg_${jobId.replace(/-/g, '')}`;

  try {
    // createStaging is INSIDE the try so the finally drops the table even if
    // index creation fails midway (review M8).
    await db.createStaging(schema, staging, targetCols, colTypes, uniqueTargetCols);
    await report.log(jobId, 'info', `created staging ${staging}; ${totalRows} rows, chunkSize ${opts.chunkSize}`);
    const chunkSize = opts.chunkSize;
    const chunkCount = Math.max(1, Math.ceil(totalRows / chunkSize));
    const batchId = await report.createBatch(jobId, totalRows, chunkSize, chunkCount);
    await report.startProgress(jobId, totalRows, chunkCount);
    await report.event('job.started', `${envelope.type} started (${totalRows} rows)`, { jobId, projectId: project.id });

    const chunks: { index: number; start: number; end: number }[] = [];
    for (let i = 0; i < chunkCount; i++) {
      chunks.push({ index: i, start: i * chunkSize, end: Math.min((i + 1) * chunkSize, totalRows) });
    }

    let cursor = 0;
    let cancelled = false;
    const workers = Array.from({ length: Math.min(config.chunkConcurrency, chunks.length) }, async () => {
      while (cursor < chunks.length) {
        if (cancelled || (await isCancelled(jobId))) {
          cancelled = true;
          return;
        }
        const chunk = chunks[cursor++]!;
        await processChunk(ctx, db, schema, staging, batchId, chunk, records, mapping, targetCols, colTypes, uniqueTargetCols);
      }
    });
    await Promise.all(workers);

    if (cancelled) {
      await report.endProgress(jobId, 'cancelled');
      throw new JobCancelled();
    }

    // Enforce `lookup` rules (referential integrity) against the target DB. Like
    // `unique`, lookups are NOT evaluated in-process (spec §10); they resolve
    // against the target DB. Done set-based AFTER staging and BEFORE promote:
    // rows whose value has no referent are recorded as row errors and removed
    // from staging so they are never promoted.
    if (lookups.length) {
      await enforceLookups(ctx, db, schema, staging, batchId, lookups, mapping);
    }

    let promoted = 0;
    if (!dryRun) {
      promoted = await db.promote(schema, entity.targetTable, staging, targetCols, uniqueTargetCols);
      await report.log(jobId, 'info', `promoted ${promoted} rows into ${entity.targetTable}`);
    } else {
      await report.log(jobId, 'info', 'dry-run: skipping promote');
    }

    await report.finishBatch(batchId);
    const { rows: errRows } = await query<{ count: number }>(
      'SELECT count(*)::int AS count FROM job_errors WHERE job_id=$1',
      [jobId],
    );
    const errorCount = errRows[0]?.count ?? 0;

    // When any row was rejected, write the WHOLE source file back to object
    // storage annotated with a per-row _status (OK/REJECTED) + _reason, so the
    // user can open it, fix the rejected rows in place, and re-import. The
    // worker already holds every source row in memory, so no re-read is needed.
    if (errorCount > 0) {
      try {
        await writeRejectsFile(jobId, records);
        await report.log(jobId, 'info', 'wrote a downloadable file with every row marked OK/REJECTED + why — fix the rejected rows and re-import');
      } catch (err) {
        await report.log(jobId, 'warn', `could not write the rejected-rows file: ${(err as Error).message}`);
      }
    }

    const summary = dryRun
      ? `dry-run: ${totalRows} rows, ${errorCount} errors`
      : `imported ${promoted}/${totalRows} rows, ${errorCount} row errors`;
    await report.completeJob(jobId, summary);
    await report.endProgress(jobId, 'completed');
    await report.event('job.completed', summary, { jobId, projectId: project.id });
    await report.log(jobId, 'info', summary);
  } finally {
    await db.dropStagingIfExists(schema, staging).catch(() => {});
  }
}

async function processChunk(
  ctx: JobContext,
  db: TargetDb,
  schema: string,
  staging: string,
  batchId: string,
  chunk: { index: number; start: number; end: number },
  records: Row[],
  mapping: Record<string, string>,
  targetCols: string[],
  colTypes: Map<string, string>,
  uniqueTargetCols: string[],
): Promise<void> {
  const jobId = ctx.job.id;
  const chunkId = await report.createChunk(batchId, chunk.index, chunk.start, chunk.end);
  await report.chunkRunning(chunkId);

  let processed = 0;
  let errors = 0;
  const sourceFields = Object.keys(mapping); // aligned with targetCols
  const colCount = targetCols.length + 1; // + row_number
  const colsSql = ['row_number', ...targetCols].map((c) => db.ident(c)).join(', ');
  const insertPrefix = `INSERT INTO ${db.qualify(schema, staging)} (${colsSql})`;

  try {
    // Phase 1: validate + transform in-process; collect rows that pass.
    const valid: { rowNumber: number; values: unknown[]; source: Row }[] = [];
    for (let r = chunk.start; r < chunk.end; r++) {
      const rowNumber = r + 1;
      const source = records[r]!;
      const { valid: ok, errors: rowErrors, value } = evaluateRow(ctx.ruleSet, source);
      if (!ok) {
        for (const e of rowErrors) await report.recordRowError(jobId, batchId, rowNumber, e.field ?? null, e.rule, e.message, source);
        errors += rowErrors.length;
        continue;
      }
      valid.push({ rowNumber, values: [rowNumber, ...sourceFields.map((sf) => coerce(value[sf], colTypes.get(mapping[sf]!)))], source });
    }

    // Phase 2: bulk multi-row INSERT in sub-batches (fast path). On a
    // constraint/data error, fall back to row-by-row for that sub-batch to
    // attribute the offending rows (keeps parallel-uniqueness/error semantics).
    // Cap the sub-batch so tuples × columns stays under the dialect bind-param
    // limit (PG 65535 / SQL Server 2100) (review H3).
    const SUB = Math.max(1, Math.min(1000, Math.floor((db.maxBindParams - 1) / colCount)));
    for (let i = 0; i < valid.length; i += SUB) {
      const slice = valid.slice(i, i + SUB);
      try {
        const params: unknown[] = [];
        const tuples = slice.map((row) => {
          row.values.forEach((v) => params.push(v));
          return `(${row.values.map(() => '?').join(',')})`;
        });
        await db.query(`${insertPrefix} VALUES ${tuples.join(',')}`, params);
        processed += slice.length;
      } catch (err) {
        if (!db.isUniqueViolation(err) && !db.isDataError(err)) throw err;
        for (const row of slice) {
          try {
            await db.query(`${insertPrefix} VALUES (${row.values.map(() => '?').join(',')})`, row.values);
            processed++;
          } catch (e) {
            if (db.isUniqueViolation(e)) {
              await report.recordRowError(jobId, batchId, row.rowNumber, uniqueTargetCols.join(',') || null, 'unique', 'duplicate business key (DB-enforced)', row.source);
              errors++;
            } else if (db.isDataError(e)) {
              await report.recordRowError(jobId, batchId, row.rowNumber, null, 'data_error', (e as Error).message, row.source);
              errors++;
            } else {
              throw e;
            }
          }
        }
      }
    }
    await report.chunkDone(batchId, chunkId, processed, errors);
    await report.tickProgress(jobId, { processed, errors, chunksDone: 1 });
    await report.log(jobId, 'info', `chunk ${chunk.index}: ${processed} staged, ${errors} errors`, { batchId, chunkIndex: chunk.index });
  } catch (err) {
    await report.chunkFailed(chunkId, (err as Error).message);
    throw err;
  }
}

/**
 * Enforce `lookup` (referential-integrity) rules against the target DB.
 *
 * A `lookup` rule means: the row's value for `field` must exist as the primary
 * key of the referenced entity's table (resolved from project_entities in the
 * SAME project, so it lives in the same target DB). This is done set-based after
 * staging and before promote — one anti-join per lookup rule — so it scales with
 * the data and stays consistent with how `unique` is DB-enforced (spec §10/§13).
 * Unmatched rows are recorded as row errors and DELETEd from staging so they are
 * not promoted. NULL/empty values are skipped (only `required` enforces presence).
 */
async function enforceLookups(
  ctx: JobContext,
  db: TargetDb,
  schema: string,
  staging: string,
  batchId: string,
  lookups: { field: string; entity: string }[],
  mapping: Record<string, string>,
): Promise<void> {
  const jobId = ctx.job.id;
  for (const lk of lookups) {
    const stagingCol = mapping[lk.field];
    if (!stagingCol) {
      throw new Error(`lookup rule on field '${lk.field}' cannot be enforced: the field is not mapped to a target column`);
    }
    // project_entities lives in the CONTROL DB (always PostgreSQL).
    const { rows: refRows } = await query<{ target_table: string; primary_key: string }>(
      `SELECT target_table, primary_key FROM project_entities WHERE project_id=$1 AND name=$2`,
      [ctx.job.project_id, lk.entity],
    );
    const ref = refRows[0];
    if (!ref) {
      throw new Error(`lookup rule references entity '${lk.entity}', which is not configured for this project`);
    }

    const sTbl = db.qualify(schema, staging);
    const rTbl = db.qualify(schema, ref.target_table);
    const sCol = db.ident(stagingCol);
    const rKey = db.ident(ref.primary_key);
    // Anti-join: staged rows whose (non-null) value has no referent. Compare as
    // text so a type mismatch between the two columns can't error the query.
    // `row_number` is a reserved word in some engines (MySQL) — quote it, and
    // alias to a safe name so the returned key is stable across dialects.
    const rnCol = db.ident('row_number');
    const { rows: missing } = await db.query<{ rn: string | number; val: unknown }>(
      `SELECT s.${rnCol} AS rn, s.${sCol} AS val
         FROM ${sTbl} s
         LEFT JOIN ${rTbl} r ON ${db.castText(`r.${rKey}`)} = ${db.castText(`s.${sCol}`)}
        WHERE s.${sCol} IS NOT NULL AND r.${rKey} IS NULL`,
    );
    if (missing.length === 0) continue;

    for (const m of missing) {
      await report.recordRowError(
        jobId, batchId, Number(m.rn), lk.field, 'lookup',
        `value '${String(m.val)}' not found in ${lk.entity}`,
        { [stagingCol]: m.val },
      );
    }
    await report.log(jobId, 'info', `lookup ${lk.field} → ${lk.entity}: ${missing.length} unmatched row(s) rejected`);
    await db.deleteStagingRows(schema, staging, missing.map((m) => Number(m.rn)));
  }
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Write the WHOLE import file back to object storage, annotated with two extra
 * columns — `_status` (OK | REJECTED) and `_reason` (the field rule(s) that
 * failed) — at `rejects/<jobId>.csv`. The gateway serves it for download so a
 * user can fix the rejected rows and re-import. Row numbers in job_errors are
 * 1-based indices into the source rows, so they line up with `records` here.
 * The extra columns are unmapped on re-import (ignored), and already-imported
 * rows are skipped idempotently — so re-uploading the fixed file Just Works.
 */
async function writeRejectsFile(jobId: string, records: Row[]): Promise<void> {
  const { rows: reasonRows } = await query<{ row_number: string; reason: string }>(
    `SELECT row_number,
            string_agg(coalesce(field || ': ', '') || message, '; ' ORDER BY id) AS reason
       FROM job_errors WHERE job_id=$1 GROUP BY row_number`,
    [jobId],
  );
  const reasonByRow = new Map<number, string>();
  for (const r of reasonRows) reasonByRow.set(Number(r.row_number), r.reason);

  const cols = records.length ? Object.keys(records[0]!) : [];
  const lines = [[...cols, '_status', '_reason'].map(csvEscape).join(',')];
  for (let i = 0; i < records.length; i++) {
    const reason = reasonByRow.get(i + 1);
    const cells = cols.map((c) => csvEscape((records[i] as Row)[c]));
    cells.push(csvEscape(reason ? 'REJECTED' : 'OK'), csvEscape(reason ?? ''));
    lines.push(cells.join(','));
  }
  await putObject(`rejects/${jobId}.csv`, lines.join('\n') + '\n', defaultBucket());
}
