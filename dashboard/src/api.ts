// Thin API client. Attaches the JWT and centralizes error handling.

const API_BASE = (import.meta.env.VITE_API_BASE as string) ?? 'http://localhost:8080';

const TOKEN_KEY = 'conductor.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  // Only declare a JSON body when we actually send one — Fastify rejects a
  // bodyless POST that carries Content-Type: application/json (e.g. the
  // test-connection / run-now / cancel buttons) with FST_ERR_CTP_EMPTY_JSON_BODY.
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (opts.auth !== false && token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;

  if (!res.ok) {
    if (res.status === 401) setToken(null);
    throw new ApiError(res.status, (data as { error?: string })?.error ?? res.statusText, data);
  }
  return data as T;
}

/** Fetch a non-JSON response (e.g. a CSV download) as text, with auth. */
export async function fetchText(path: string): Promise<string> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    if (res.status === 401) setToken(null);
    throw new ApiError(res.status, res.statusText);
  }
  return res.text();
}

/** Fetch a binary response (e.g. an .xlsx download) as a Blob, with auth. */
export async function fetchBlob(path: string): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    if (res.status === 401) setToken(null);
    throw new ApiError(res.status, res.statusText);
  }
  return res.blob();
}

/** Multipart upload — lets the browser set the multipart boundary itself. */
export async function uploadFile<T = unknown>(path: string, file: File): Promise<T> {
  const fd = new FormData();
  fd.append('file', file);
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    if (res.status === 401) setToken(null);
    throw new ApiError(res.status, (data as { error?: string })?.error ?? res.statusText, data);
  }
  return data as T;
}

export { API_BASE };
