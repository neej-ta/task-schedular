import type { Handler } from '@conductor/worker-runtime';
import { bulkImport } from './bulkImport.js';
import { bulkUpdate } from './bulkUpdate.js';
import { bulkDelete } from './bulkDelete.js';

// worker-core = the rule-bearing pool. bulk_import / bulk_insert / xml_integration
// all run the same staging→promote pipeline with different source readers.
export const handlers: Record<string, Handler> = {
  bulk_import: bulkImport,
  bulk_insert: bulkImport,
  xml_integration: bulkImport,
  bulk_update: bulkUpdate,
  bulk_delete: bulkDelete,
};
