import { parse } from 'csv-parse/sync';
import { XMLParser } from 'fast-xml-parser';
import { getObjectText, parseS3Url } from '@conductor/storage';
import type { Row } from '@conductor/rule-engine';
import type { JobContext } from '@conductor/worker-runtime';

function findFirstArray(node: unknown): unknown[] | null {
  if (Array.isArray(node)) return node;
  if (node && typeof node === 'object') {
    for (const v of Object.values(node)) {
      const found = findFirstArray(v);
      if (found) return found;
    }
  }
  return null;
}

/** Read source rows according to source.kind (csv | json | xml | inline). */
export async function readRows(ctx: JobContext): Promise<Row[]> {
  const src = ctx.envelope.source as {
    kind: string;
    location?: string;
    rows?: Row[];
    options?: Record<string, unknown>;
  };
  if (src.kind === 'inline' && Array.isArray(src.rows)) return src.rows;

  const location = src.location ?? (ctx.job.source_jsonb.location as string | undefined);
  if (!location) throw new Error(`${ctx.envelope.type}: no source.location`);
  const { bucket, key } = parseS3Url(location);
  const text = await getObjectText(bucket, key);

  if (src.kind === 'json') {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : ((parsed.rows as Row[]) ?? []);
  }
  if (src.kind === 'xml') {
    const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });
    const tree = parser.parse(text);
    const recordPath = (src.options?.recordPath as string) || (ctx.job.source_jsonb.recordPath as string | undefined);
    let node: unknown = tree;
    if (recordPath) for (const part of recordPath.split('.')) node = (node as Record<string, unknown>)?.[part];
    else node = findFirstArray(tree);
    return Array.isArray(node) ? (node as Row[]) : node ? [node as Row] : [];
  }
  return parse(text, { columns: true, skip_empty_lines: true, trim: false }) as Row[];
}
