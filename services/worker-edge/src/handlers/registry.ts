import type { Handler } from '@conductor/worker-runtime';
import { fileInbound } from './fileInbound.js';
import { fileOutbound } from './fileOutbound.js';
import { restPull } from './restPull.js';
import { restPush } from './restPush.js';
import { webhook } from './webhook.js';

// worker-edge = the integration pool (lightweight file/REST I/O, spec §4).
export const handlers: Record<string, Handler> = {
  file_inbound: fileInbound,
  file_outbound: fileOutbound,
  rest_pull: restPull,
  rest_push: restPush,
  // Scheduler-only trigger → POSTs to a project's own job endpoint.
  webhook,
};
