import { evaluateRow, type Row } from '@conductor/rule-engine';
import { getTargetDb, type TargetDb } from '@conductor/targetdb';
import { isCancelled } from '@conductor/realtime';
import { report, JobCancelled, type JobContext } from '@conductor/worker-runtime';
import { readRows } from './source.js';
import { config } from './config.js';

export interface RowOutcome {
  processed: boolean;
  error?: { field?: string | null; rule: string; message: string };
}
export type PerRow = (args: {
  rowNumber: number;
  source: Row;
  value: Row;
  db: TargetDb;
  ctx: JobContext;
}) => Promise<RowOutcome>;

/**
 * Shared chunked row processor for bulk_update / bulk_delete (spec §11/§12):
 * read → (optionally validate) → per-row action, with batch/chunk visibility,
 * Redis progress, bounded concurrency, and cancellation at chunk boundaries.
 * The caller finalizes the job (completeJob + summary) from the returned counts.
 */
export async function runRowJob(
  ctx: JobContext,
  perRow: PerRow,
  opts: { validate?: boolean } = {},
): Promise<{ total: number; processed: number; errors: number }> {
  const { job, project, envelope } = ctx;
  const jobId = job.id;
  const validate = opts.validate ?? true;

  const records = await readRows(ctx);
  const total = records.length;
  const db = await getTargetDb(project);

  const chunkSize = envelope.options.chunkSize;
  const chunkCount = Math.max(1, Math.ceil(total / chunkSize));
  const batchId = await report.createBatch(jobId, total, chunkSize, chunkCount);
  await report.startProgress(jobId, total, chunkCount);
  await report.event('job.started', `${envelope.type} started (${total} rows)`, { jobId, projectId: project.id });

  const chunks: { index: number; start: number; end: number }[] = [];
  for (let i = 0; i < chunkCount; i++) {
    chunks.push({ index: i, start: i * chunkSize, end: Math.min((i + 1) * chunkSize, total) });
  }

  let cursor = 0;
  let cancelled = false;
  let processed = 0;
  let errorsTotal = 0;

  const workers = Array.from({ length: Math.min(config.chunkConcurrency, chunks.length) }, async () => {
    while (cursor < chunks.length) {
      if (cancelled || (await isCancelled(jobId))) {
        cancelled = true;
        return;
      }
      const chunk = chunks[cursor++]!;
      const chunkId = await report.createChunk(batchId, chunk.index, chunk.start, chunk.end);
      await report.chunkRunning(chunkId);
      let cProc = 0;
      let cErr = 0;
      try {
        for (let r = chunk.start; r < chunk.end; r++) {
          const rowNumber = r + 1;
          const source = records[r]!;
          let value: Row = source;
          if (validate) {
            const ev = evaluateRow(ctx.ruleSet, source);
            if (!ev.valid) {
              for (const e of ev.errors) await report.recordRowError(jobId, batchId, rowNumber, e.field ?? null, e.rule, e.message, source);
              cErr += ev.errors.length;
              continue;
            }
            value = ev.value;
          }
          const out = await perRow({ rowNumber, source, value, db, ctx });
          if (out.processed) cProc++;
          if (out.error) {
            await report.recordRowError(jobId, batchId, rowNumber, out.error.field ?? null, out.error.rule, out.error.message, source);
            cErr++;
          }
        }
        await report.chunkDone(batchId, chunkId, cProc, cErr);
        await report.tickProgress(jobId, { processed: cProc, errors: cErr, chunksDone: 1 });
        processed += cProc;
        errorsTotal += cErr;
      } catch (err) {
        await report.chunkFailed(chunkId, (err as Error).message);
        throw err;
      }
    }
  });
  await Promise.all(workers);

  if (cancelled) {
    await report.endProgress(jobId, 'cancelled');
    throw new JobCancelled();
  }
  await report.finishBatch(batchId);
  return { total, processed, errors: errorsTotal };
}

/** Find the source field that maps to a given target column. */
export function sourceFieldFor(mapping: Record<string, string>, targetCol: string): string | undefined {
  for (const [src, tgt] of Object.entries(mapping)) if (tgt === targetCol) return src;
  return undefined;
}

/**
 * Default match column for key-based jobs (bulk_update / bulk_delete): prefer a
 * mapped business key (customer_code-style `*_code`/`*_key`/`email`) that also
 * exists on the target, before any caller falls back to the surrogate PK — which
 * the source file almost never carries a mapping for.
 */
export function firstUnique(colTypes: Map<string, string>, mapping: Record<string, string>): string | undefined {
  for (const tgt of Object.values(mapping)) if (/code|key|email/i.test(tgt) && colTypes.has(tgt)) return tgt;
  return undefined;
}
