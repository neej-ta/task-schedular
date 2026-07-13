import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Code2,
  Download,
  FileDown,
  FilePlus2,
  PencilLine,
  Trash2,
  Upload,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import type { JobType } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Friendly wording layer — turns technical enums into plain English so anyone,
// technical or not, understands what's happening. One place to keep it consistent.
// ─────────────────────────────────────────────────────────────────────────────

export interface TypeInfo {
  label: string; // human name shown everywhere
  blurb: string; // one-line "what it does"
  icon: LucideIcon;
}

export const JOB_TYPE_INFO: Record<JobType, TypeInfo> = {
  bulk_import: { label: 'Import data', blurb: 'Load rows from a file into a table', icon: FilePlus2 },
  bulk_insert: { label: 'Add records', blurb: 'Add new rows to a table', icon: Download },
  bulk_update: { label: 'Update records', blurb: 'Change existing rows, matched by a key', icon: PencilLine },
  bulk_delete: { label: 'Delete records', blurb: 'Remove rows (safely, unless told otherwise)', icon: Trash2 },
  xml_integration: { label: 'Import XML', blurb: 'Load rows from an XML file', icon: Code2 },
  file_inbound: { label: 'Fetch a file', blurb: 'Download a file, then import it', icon: ArrowDownToLine },
  file_outbound: { label: 'Export a file', blurb: 'Save table data out to a file', icon: FileDown },
  rest_pull: { label: 'Import from an API', blurb: 'Pull records from a web service', icon: ArrowDownToLine },
  rest_push: { label: 'Send to an API', blurb: 'Push records to a web service', icon: ArrowUpFromLine },
  webhook: { label: 'Trigger a project job', blurb: 'On schedule, call a project endpoint to run its own job', icon: Webhook },
};

export function typeInfo(type: string): TypeInfo {
  return (JOB_TYPE_INFO as Record<string, TypeInfo>)[type] ?? { label: type, blurb: '', icon: Upload };
}

export type Tone = 'amber' | 'blue' | 'green' | 'red' | 'slate';

export interface StatusInfo {
  label: string; // friendly word
  tone: Tone; // pill colour
  help: string; // tooltip
}

export const STATUS_INFO: Record<string, StatusInfo> = {
  queued: { label: 'Waiting', tone: 'amber', help: 'In line, will start soon' },
  running: { label: 'Running', tone: 'blue', help: 'Working on it right now' },
  retrying: { label: 'Retrying', tone: 'blue', help: 'Hit a snag — trying again' },
  completed: { label: 'Done', tone: 'green', help: 'Finished successfully' },
  failed: { label: 'Failed', tone: 'red', help: 'Could not finish — check the details' },
  cancelling: { label: 'Stopping', tone: 'slate', help: 'Cancelling — finishing the current step' },
  cancelled: { label: 'Cancelled', tone: 'slate', help: 'Stopped by a person' },
};

export function statusInfo(status: string): StatusInfo {
  return STATUS_INFO[status] ?? { label: status, tone: 'slate', help: '' };
}
