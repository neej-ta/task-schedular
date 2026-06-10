import type pg from 'pg';
import { query } from '@conductor/db';
import { evaluateRow, extractStatefulRules, type Row } from '@conductor/rule-engine';
import { getTargetPool, quoteIdent, introspectColumns, coerce } from '@conductor/targetdb';
import { isCancelled } from '@conductor/realtime';
import { putObject, defaultBucket } from '@conductor/storage';
import { report, JobCancelled, type JobContext } from '@conductor/worker-runtime';
import { readRows } from '../source.js';
import { config } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared import pipeline (spec §11) for bulk_import / bulk_insert / xml_integration:
//   read (csv|json|xml) → map → validate (in-process rules) → transform →
//   STAGING table → promote (idempotent ON CONFLICT DO NOTHING).
// Uniqueness is DB-enforced on staging; concurrent chunks race the DB, not app
// code (spec §5.5, §13). Re-runs/redeliveries never duplicate (idempotent promote).
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

  const pool = await getTargetPool(project);
  const schema = project.schema || 'public';
  const colTypes = await introspectColumns(pool, schema, entity.targetTable);

  const staging = `conductor_stg_${jobId.replace(/-/g, '')}`;

  try {
    // createStaging is INSIDE the try so the finally drops the table even if
    // index creation fails midway (review M8).
    await createStaging(pool, schema, staging, targetCols, colTypes, uniqueTargetCols);
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
        await processChunk(ctx, pool, schema, staging, batchId, chunk, records, mapping, targetCols, colTypes, uniqueTargetCols);
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
      await enforceLookups(ctx, pool, schema, staging, batchId, lookups, mapping);
    }

    let promoted = 0;
    if (!dryRun) {
      const cols = targetCols.map(quoteIdent).join(', ');
      // The promote is a single large INSERT…SELECT — expected to be long for
      // big jobs. Exempt it from the per-project statement_timeout (which guards
      // ad-hoc/validation queries) via SET LOCAL inside a transaction.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL statement_timeout = 0');
        const res = await client.query(
          `INSERT INTO ${quoteIdent(schema)}.${quoteIdent(entity.targetTable)} (${cols})
           SELECT ${cols} FROM ${quoteIdent(schema)}.${quoteIdent(staging)}
           ON CONFLICT DO NOTHING`,
        );
        await client.query('COMMIT');
        promoted = res.rowCount ?? 0;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
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
    await pool.query(`DROP TABLE IF EXISTS ${quoteIdent(schema)}.${quoteIdent(staging)}`).catch(() => {});
  }
}

async function processChunk(
  ctx: JobContext,
  pool: pg.Pool,
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
  const colsSql = ['row_number', ...targetCols].map(quoteIdent).join(', ');
  const insertPrefix = `INSERT INTO ${quoteIdent(schema)}.${quoteIdent(staging)} (${colsSql})`;

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
    // Cap the sub-batch so tuples × columns stays well under PG's 65535 bind
    // parameter limit (review H3).
    const SUB = Math.max(1, Math.min(1000, Math.floor(60000 / colCount)));
    for (let i = 0; i < valid.length; i += SUB) {
      const slice = valid.slice(i, i + SUB);
      try {
        const params: unknown[] = [];
        const tuples = slice.map((row, ri) => {
          row.values.forEach((v) => params.push(v));
          return `(${row.values.map((_, ci) => `$${ri * colCount + ci + 1}`).join(',')})`;
        });
        await pool.query(`${insertPrefix} VALUES ${tuples.join(',')}`, params);
        processed += slice.length;
      } catch (err) {
        const code = (err as { code?: string }).code ?? '';
        if (code !== '23505' && !code.startsWith('22') && !code.startsWith('23')) throw err;
        for (const row of slice) {
          try {
            await pool.query(`${insertPrefix} VALUES (${row.values.map((_, ci) => `$${ci + 1}`).join(',')})`, row.values);
            processed++;
          } catch (e) {
            const c = (e as { code?: string }).code ?? '';
            if (c === '23505') {
              await report.recordRowError(jobId, batchId, row.rowNumber, uniqueTargetCols.join(',') || null, 'unique', 'duplicate business key (DB-enforced)', row.source);
              errors++;
            } else if (c.startsWith('22') || c.startsWith('23')) {
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

async function createStaging(
  pool: pg.Pool,
  schema: string,
  staging: string,
  targetCols: string[],
  colTypes: Map<string, string>,
  uniqueTargetCols: string[],
): Promise<void> {
  await pool.query(`DROP TABLE IF EXISTS ${quoteIdent(schema)}.${quoteIdent(staging)}`);
  const colDefs = targetCols.map((c) => `${quoteIdent(c)} ${colTypes.get(c) ?? 'text'}`).join(', ');
  await pool.query(
    `CREATE UNLOGGED TABLE ${quoteIdent(schema)}.${quoteIdent(staging)} (
       row_number bigint PRIMARY KEY,
       ${colDefs}
     )`,
  );
  for (const col of uniqueTargetCols) {
    await pool.query(
      `CREATE UNIQUE INDEX ${quoteIdent(`uq_${staging}_${col}`)} ON ${quoteIdent(schema)}.${quoteIdent(staging)} (${quoteIdent(col)})`,
    );
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
  pool: pg.Pool,
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
    const { rows: refRows } = await query<{ target_table: string; primary_key: string }>(
      `SELECT target_table, primary_key FROM project_entities WHERE project_id=$1 AND name=$2`,
      [ctx.job.project_id, lk.entity],
    );
    const ref = refRows[0];
    if (!ref) {
      throw new Error(`lookup rule references entity '${lk.entity}', which is not configured for this project`);
    }

    const sTbl = `${quoteIdent(schema)}.${quoteIdent(staging)}`;
    const rTbl = `${quoteIdent(schema)}.${quoteIdent(ref.target_table)}`;
    const sCol = quoteIdent(stagingCol);
    const rKey = quoteIdent(ref.primary_key);
    // Anti-join: staged rows whose (non-null) value has no referent. Compare as
    // text so a type mismatch between the two columns can't error the query.
    const { rows: missing } = await pool.query<{ row_number: string; val: unknown }>(
      `SELECT s.row_number, s.${sCol} AS val
         FROM ${sTbl} s
         LEFT JOIN ${rTbl} r ON r.${rKey}::text = s.${sCol}::text
        WHERE s.${sCol} IS NOT NULL AND r.${rKey} IS NULL`,
    );
    if (missing.length === 0) continue;

    for (const m of missing) {
      await report.recordRowError(
        jobId, batchId, Number(m.row_number), lk.field, 'lookup',
        `value '${String(m.val)}' not found in ${lk.entity}`,
        { [stagingCol]: m.val },
      );
    }
    await report.log(jobId, 'info', `lookup ${lk.field} → ${lk.entity}: ${missing.length} unmatched row(s) rejected`);
    await pool.query(`DELETE FROM ${sTbl} WHERE row_number = ANY($1::bigint[])`, [missing.map((m) => Number(m.row_number))]);
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
