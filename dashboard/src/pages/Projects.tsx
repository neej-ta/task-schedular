import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, Plug, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import type { Project, Provider, TestConnectionResult } from '../types';
import { Button, Card, EmptyState, Field, Hint, Input, PageHeader, Pill, Select } from '../ui';

const DEFAULT_PORTS: Record<Provider, number> = { postgres: 5432, mysql: 3306, sqlserver: 1433 };
const PROVIDER_LABEL: Record<Provider, string> = { postgres: 'PostgreSQL', mysql: 'MySQL', sqlserver: 'SQL Server' };

// Connection-string scheme → provider. Lets users paste a single URL instead of
// filling six fields. (`new URL` returns percent-encoded user/pass, so decode.)
const SCHEME_TO_PROVIDER: Record<string, Provider> = {
  postgres: 'postgres', postgresql: 'postgres',
  mysql: 'mysql', mariadb: 'mysql',
  sqlserver: 'sqlserver', mssql: 'sqlserver',
};

interface ParsedDbUrl {
  provider: Provider; host: string; port: number; database: string;
  username: string; secret: string; sslMode?: string; schema?: string;
}

/** Parse a DB connection URL into the discrete fields the API expects. Throws a
 *  friendly Error on anything malformed so the form can show it inline. */
function parseDbUrl(raw: string): ParsedDbUrl {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new Error('That doesn’t look like a valid URL.'); }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  const provider = SCHEME_TO_PROVIDER[scheme];
  if (!provider) throw new Error(`Unsupported scheme “${scheme}://” — use postgresql://, mysql://, or sqlserver://`);
  const host = u.hostname;
  if (!host) throw new Error('The URL is missing a host.');
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!database) throw new Error('The URL is missing a database name (e.g. …:5432/mydb).');
  const username = decodeURIComponent(u.username);
  if (!username) throw new Error('The URL is missing a username.');
  const secret = decodeURIComponent(u.password);
  if (!secret) throw new Error('The URL is missing a password (encode special chars, e.g. @ → %40).');
  const port = u.port ? Number(u.port) : DEFAULT_PORTS[provider];
  const sslMode = u.searchParams.get('sslmode') ?? u.searchParams.get('ssl') ?? undefined;
  const schema = u.searchParams.get('schema') ?? u.searchParams.get('search_path') ?? undefined;
  return { provider, host, port, database, username, secret, sslMode, schema };
}

export function Projects() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [results, setResults] = useState<Record<string, TestConnectionResult | 'pending'>>({});

  const { data, isLoading, error } = useQuery({ queryKey: ['projects'], queryFn: () => api<{ projects: Project[] }>('/projects') });

  const testConn = useMutation({
    mutationFn: (id: string) => api<TestConnectionResult>(`/projects/${id}/test-connection`, { method: 'POST' }),
    onMutate: (id) => setResults((r) => ({ ...r, [id]: 'pending' })),
    onSuccess: (res, id) => setResults((r) => ({ ...r, [id]: res })),
    onError: (e, id) => setResults((r) => ({ ...r, [id]: { ok: false, latencyMs: 0, error: e instanceof Error ? e.message : 'error' } })),
  });

  const isAdmin = user?.role === 'admin';
  const canTest = user?.role === 'admin' || user?.role === 'operator';

  return (
    <div>
      <PageHeader
        title="Connections"
        description="The databases Conductor reads from and writes to. Add a connection, then tasks can move data in and out of it. Passwords are encrypted and never shown."
        actions={isAdmin ? <Button onClick={() => setShowForm((s) => !s)}><Plug className="h-4 w-4" />{showForm ? 'Close' : 'Add connection'}</Button> : undefined}
      />

      {showForm && isAdmin && <div className="mb-4"><CreateForm onCreated={() => { setShowForm(false); void qc.invalidateQueries({ queryKey: ['projects'] }); }} /></div>}

      {isLoading && <p className="text-slate-400">Loading…</p>}
      {error && <p className="text-rose-600">{(error as Error).message}</p>}

      {data && data.projects.length === 0 ? (
        <EmptyState icon={<Database className="h-10 w-10" />} title="No connections yet">
          {isAdmin ? 'Add a connection to a database so Conductor can move data in and out of it.' : 'Ask an admin to add a database connection.'}
        </EmptyState>
      ) : (
        <div className="grid gap-3">
          {data?.projects.map((p) => {
            const res = results[p.id];
            return (
              <Card key={p.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500"><Database className="h-4.5 w-4.5" /></span>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-800">{p.name}</span>
                      <Pill tone={p.environment === 'prod' ? 'amber' : 'blue'}>{p.environment === 'prod' ? 'Production' : 'Test'}</Pill>
                      {p.status !== 'active' && <Pill tone="slate">Disabled</Pill>}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-400">{PROVIDER_LABEL[p.provider]} · {p.username}@{p.host}:{p.port}/{p.database}</div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {res === 'pending' && <span className="text-xs text-slate-400">Testing…</span>}
                  {res && res !== 'pending' && (res.ok
                    ? <Pill tone="green"><ShieldCheck className="h-3 w-3" /> Connected · {res.latencyMs}ms</Pill>
                    : <Pill tone="red" title={res.error}>Can't connect</Pill>)}
                  {canTest && <Button variant="ghost" onClick={() => testConn.mutate(p.id)}>Test connection</Button>}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CreateForm({ onCreated }: { onCreated: () => void }) {
  const [form, setForm] = useState({
    name: '', dbUrl: '', environment: 'test' as 'prod' | 'test', allowlistHosts: '',
  });
  const [err, setErr] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const p = parseDbUrl(form.dbUrl);
      // Auto-allow the URL's host (the admin explicitly provided it) and merge
      // any extra hosts/CIDRs the admin listed — required for private targets.
      const extra = form.allowlistHosts ? form.allowlistHosts.split(',').map((s) => s.trim()).filter(Boolean) : [];
      const allowlistHosts = Array.from(new Set([p.host, ...extra]));
      return api('/projects', {
        method: 'POST',
        body: {
          name: form.name, provider: p.provider, host: p.host, port: p.port, database: p.database,
          username: p.username, secret: p.secret, environment: form.environment,
          ...(p.sslMode ? { sslMode: p.sslMode } : {}),
          ...(p.schema ? { schema: p.schema } : {}),
          allowlistHosts,
        },
      });
    },
    onSuccess: onCreated,
    onError: (e) => setErr(e instanceof Error ? e.message : 'failed'),
  });

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) { setForm((f) => ({ ...f, [k]: v })); }
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try { parseDbUrl(form.dbUrl); } catch (e) { setErr(e instanceof Error ? e.message : 'invalid URL'); return; }
    create.mutate();
  }

  // Live preview of what we parsed (or the inline parse error).
  let parsed: ParsedDbUrl | null = null;
  let parseErr: string | null = null;
  if (form.dbUrl.trim()) {
    try { parsed = parseDbUrl(form.dbUrl); } catch (e) { parseErr = e instanceof Error ? e.message : 'invalid URL'; }
  }

  return (
    <Card className="p-5">
      <form onSubmit={onSubmit} className="space-y-4">
        <Hint>Paste your database connection URL. We'll test it before anything runs, and the password is encrypted at rest — it's never shown again.</Hint>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name" hint="A friendly label, e.g. “Production DB”"><Input value={form.name} onChange={(e) => set('name', e.target.value)} required /></Field>
          <Field label="Environment"><Select value={form.environment} onChange={(e) => set('environment', e.target.value as 'prod' | 'test')}><option value="test">Test</option><option value="prod">Production</option></Select></Field>
        </div>
        <Field label="Database URL" hint="postgresql:// · mysql:// · sqlserver:// — encode special chars in the password (@ → %40)">
          <Input value={form.dbUrl} onChange={(e) => set('dbUrl', e.target.value)} placeholder="postgresql://user:password@host.docker.internal:5432/mydb" required />
        </Field>
        {parsed && (
          <p className="text-xs text-emerald-600">
            ✓ {PROVIDER_LABEL[parsed.provider]} · {parsed.username}@{parsed.host}:{parsed.port}/{parsed.database}
            {parsed.sslMode ? ` · ssl=${parsed.sslMode}` : ''}
          </p>
        )}
        {parseErr && <p className="text-xs text-rose-600">{parseErr}</p>}
        <Field label="Allowed hosts" hint="The URL's host is allow-listed automatically. Add extra hosts/CIDRs here if needed.">
          <Input value={form.allowlistHosts} onChange={(e) => set('allowlistHosts', e.target.value)} placeholder="10.0.0.0/8, db2.example.com" />
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={create.isPending}>{create.isPending ? 'Saving…' : 'Save connection'}</Button>
          {err && <span className="text-sm text-rose-600">{err}</span>}
        </div>
      </form>
    </Card>
  );
}
