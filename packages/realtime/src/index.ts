import { Redis } from 'ioredis';

// ─────────────────────────────────────────────────────────────────────────────
// Realtime plane (spec §4): Redis pub/sub for live log/progress/state streaming,
// progress-counter hashes, and cancellation flags. Publishers = worker; the
// gateway subscribes and fans out to SSE/WS clients.
// ─────────────────────────────────────────────────────────────────────────────

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379', {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });
    client.on('error', (e) => console.error('[redis] error', e.message));
  }
  return client;
}

const jobChannel = (jobId: string) => `conductor:job:${jobId}`;
export const ACTIVITY_CHANNEL = 'conductor:activity';
const progressKey = (jobId: string) => `conductor:progress:${jobId}`;
const cancelKey = (jobId: string) => `conductor:cancel:${jobId}`;

// ── Message types ─────────────────────────────────────────────────────────────
export interface LogMessage {
  kind: 'log';
  id: number;
  ts: string;
  level: string;
  message: string;
  chunkIndex?: number | null;
}
export interface ProgressMessage {
  kind: 'progress';
  processed: number;
  total: number;
  errors: number;
  chunksRemaining: number;
  status: string;
}
export interface StateMessage {
  kind: 'state';
  status: string;
  ts: string;
  message?: string;
}
export type JobMessage = LogMessage | ProgressMessage | StateMessage;

export interface ActivityEvent {
  ts: string;
  type: string;
  jobId?: string | null;
  projectId?: string | null;
  actor?: string | null;
  message: string;
}

// ── Publish ──────────────────────────────────────────────────────────────────
export async function publishJob(jobId: string, msg: JobMessage): Promise<void> {
  await getRedis().publish(jobChannel(jobId), JSON.stringify(msg));
}
export async function publishActivity(ev: ActivityEvent): Promise<void> {
  await getRedis().publish(ACTIVITY_CHANNEL, JSON.stringify(ev));
}

// ── Subscribe (dedicated connection per subscriber) ───────────────────────────
export function subscribeJob(jobId: string, handler: (m: JobMessage) => void): () => void {
  const sub = getRedis().duplicate();
  void sub.subscribe(jobChannel(jobId));
  sub.on('message', (_ch, payload) => {
    try {
      handler(JSON.parse(payload) as JobMessage);
    } catch {
      /* ignore malformed */
    }
  });
  return () => void sub.quit();
}

export function subscribeActivity(handler: (e: ActivityEvent) => void): () => void {
  const sub = getRedis().duplicate();
  void sub.subscribe(ACTIVITY_CHANNEL);
  sub.on('message', (_ch, payload) => {
    try {
      handler(JSON.parse(payload) as ActivityEvent);
    } catch {
      /* ignore */
    }
  });
  return () => void sub.quit();
}

// ── Progress counters ─────────────────────────────────────────────────────────
export async function initProgress(jobId: string, total: number, chunksRemaining: number): Promise<void> {
  await getRedis().hset(progressKey(jobId), {
    total: String(total),
    processed: '0',
    errors: '0',
    chunksRemaining: String(chunksRemaining),
    status: 'running',
  });
  await getRedis().expire(progressKey(jobId), 86_400);
}

export async function bumpProgress(
  jobId: string,
  delta: { processed?: number; errors?: number; chunksDone?: number },
): Promise<ProgressMessage> {
  const r = getRedis();
  const k = progressKey(jobId);
  if (delta.processed) await r.hincrby(k, 'processed', delta.processed);
  if (delta.errors) await r.hincrby(k, 'errors', delta.errors);
  if (delta.chunksDone) await r.hincrby(k, 'chunksRemaining', -delta.chunksDone);
  return getProgress(jobId);
}

export async function setProgressStatus(jobId: string, status: string): Promise<void> {
  await getRedis().hset(progressKey(jobId), 'status', status);
}

export async function getProgress(jobId: string): Promise<ProgressMessage> {
  const h = await getRedis().hgetall(progressKey(jobId));
  return {
    kind: 'progress',
    processed: Number(h.processed ?? 0),
    total: Number(h.total ?? 0),
    errors: Number(h.errors ?? 0),
    chunksRemaining: Number(h.chunksRemaining ?? 0),
    status: h.status ?? 'unknown',
  };
}

// ── Per-project concurrency semaphore (spec §12) ─────────────────────────────
const slotKey = (projectId: string) => `conductor:running:${projectId}`;

/**
 * Try to take a concurrency slot for a project. Atomic INCR; if it would exceed
 * the project's limit, DECR back and return false (caller defers the job). The
 * key has a TTL so a crashed worker's slot is eventually reclaimed.
 */
// Atomic INCR + TTL + over-limit rollback in ONE round-trip (Lua), so a mid-call
// failure can never leave a dangling increment or an untimed key (review H1/M3).
const ACQUIRE_LUA = `
local n = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
if n > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1`;

export async function acquireProjectSlot(projectId: string, limit: number): Promise<boolean> {
  const got = await getRedis().eval(ACQUIRE_LUA, 1, slotKey(projectId), String(limit), '3600');
  return got === 1;
}

export async function releaseProjectSlot(projectId: string): Promise<void> {
  const r = getRedis();
  const k = slotKey(projectId);
  // Floor at 0 to avoid drift going negative.
  const n = await r.decr(k);
  if (n < 0) await r.set(k, '0');
}

export async function runningCount(projectId: string): Promise<number> {
  return Number((await getRedis().get(slotKey(projectId))) ?? 0);
}

// ── Cancellation flags ─────────────────────────────────────────────────────────
export async function requestCancel(jobId: string): Promise<void> {
  await getRedis().set(cancelKey(jobId), '1', 'EX', 3600);
}
export async function isCancelled(jobId: string): Promise<boolean> {
  return (await getRedis().exists(cancelKey(jobId))) === 1;
}
export async function clearCancel(jobId: string): Promise<void> {
  await getRedis().del(cancelKey(jobId));
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
