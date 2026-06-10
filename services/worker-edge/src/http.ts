import { assertHostAllowed, envAllowlist } from '@conductor/security';
import { config } from './config.js';

// REST helpers with SSRF protection + exponential backoff (spec §7, §11). The
// target URL comes from job source/destination, so it MUST pass the same
// deny-by-default egress guard as DB connections: deny private/loopback/
// metadata ranges, validate the resolved IP, honor the per-project allow-list,
// reject non-http(s) schemes, and refuse redirects (redirect-based rebinding).

function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function guard(url: string, allowlist: string[]): Promise<URL> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`scheme not allowed for REST handler: ${u.protocol}`);
  }
  await assertHostAllowed(u.hostname, [...envAllowlist(), ...allowlist]);
  return u;
}

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  // Retry network errors + 5xx + 429; do NOT retry other 4xx (permanent).
  if (status === undefined) return true;
  return status >= 500 || status === 429;
}

async function withBackoff<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= config.httpRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < config.httpRetries && isRetryable(err)) {
        const base = config.httpBackoffBaseMs * 2 ** attempt;
        const jitter = Math.floor(Math.random() * config.httpBackoffBaseMs);
        await new Promise((r) => setTimeout(r, base + jitter));
      } else {
        break;
      }
    }
  }
  throw new Error(`${label} failed: ${(lastErr as Error).message}`);
}

export interface HttpOpts {
  token?: string;
  allowlist?: string[];
}

export async function fetchJson(url: string, opts: HttpOpts = {}): Promise<unknown> {
  await guard(url, opts.allowlist ?? []);
  return withBackoff(async () => {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', ...authHeaders(opts.token) },
      redirect: 'manual', // a 3xx to a private/metadata host would bypass the guard
    });
    if (res.status >= 300 && res.status < 400) throw withStatus(`GET ${url} redirected (${res.status}) — not allowed`, res.status);
    if (!res.ok) throw withStatus(`GET ${url} → HTTP ${res.status}`, res.status);
    return res.json();
  }, `GET ${url}`);
}

export async function postJson(url: string, body: unknown, opts: HttpOpts = {}): Promise<void> {
  await guard(url, opts.allowlist ?? []);
  await withBackoff(async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(opts.token) },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) throw withStatus(`POST ${url} redirected (${res.status}) — not allowed`, res.status);
    if (!res.ok) throw withStatus(`POST ${url} → HTTP ${res.status}`, res.status);
    return res.text();
  }, `POST ${url}`);
}

function withStatus(message: string, status: number): Error {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  return e;
}
