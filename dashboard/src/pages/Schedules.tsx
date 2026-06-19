import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Pause, Play, Zap } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import type { JobDefinition, JobType, Project } from '../types';
import { typeInfo } from '../labels';
import { Button, Card, EmptyState, Field, Hint, Input, PageHeader, Pagination, Pill, Select } from '../ui';
import { previewCron, humanize, DAY_LABELS, type ScheduleSpec, type ScheduleKind } from '../schedule';

const JOB_TYPES: JobType[] = [
  'bulk_import', 'bulk_insert', 'bulk_update', 'bulk_delete',
  'file_inbound', 'file_outbound', 'xml_integration', 'rest_pull', 'rest_push',
];

function whenText(d: JobDefinition): string {
  if (d.next_run_at) return `Next run ${new Date(d.next_run_at).toLocaleString()}`;
  if (d.schedule_kind === 'one_time') return 'Runs once (or on demand)';
  return 'On demand';
}

export function Schedules({ onOpenJob }: { onOpenJob: (id: string) => void }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const canEdit = user?.role === 'admin' || user?.role === 'operator';

  useEffect(() => { setPage(1); }, [pageSize]);

  const { data, isLoading } = useQuery({
    queryKey: ['definitions'],
    queryFn: () => api<{ definitions: JobDefinition[] }>('/job-definitions'),
    refetchInterval: 5000,
  });

  const defs = data?.definitions ?? [];
  const totalPages = Math.max(1, Math.ceil(defs.length / pageSize));
  const effectivePage = Math.min(page, totalPages);
  const pagedDefs = defs.slice((effectivePage - 1) * pageSize, effectivePage * pageSize);

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api(`/job-definitions/${id}/${enabled ? 'disable' : 'enable'}`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['definitions'] }),
  });
  const runNow = useMutation({
    mutationFn: (id: string) => api<{ jobId: string }>(`/job-definitions/${id}/run-now`, { method: 'POST' }),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['jobs'] }); if (r.jobId) onOpenJob(r.jobId); },
  });

  return (
    <div>
      <PageHeader
        title="Schedules"
        description="Set up a task to run automatically — every day, week, or month — or keep it on demand and press Run now whenever you like."
        actions={canEdit ? <Button onClick={() => setShowForm((s) => !s)}><CalendarClock className="h-4 w-4" />{showForm ? 'Close' : 'New schedule'}</Button> : undefined}
      />

      {showForm && canEdit && <div className="mb-4"><CreateForm onCreated={() => { setShowForm(false); void qc.invalidateQueries({ queryKey: ['definitions'] }); }} /></div>}

      {isLoading && <p className="text-slate-400">Loading…</p>}

      {data && data.definitions.length === 0 ? (
        <EmptyState icon={<CalendarClock className="h-10 w-10" />} title="No schedules yet">
          A schedule is a saved task you can run on a timer or on demand. {canEdit ? 'Click “New schedule” to create one.' : ''}
        </EmptyState>
      ) : (
        <div className="grid gap-3">
          {pagedDefs.map((d) => {
            const t = typeInfo(d.type);
            return (
              <Card key={d.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500"><t.icon className="h-4.5 w-4.5" /></span>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-800">{d.name}</span>
                      <Pill tone={d.enabled ? 'green' : 'slate'}>{d.enabled ? 'Active' : 'Paused'}</Pill>
                    </div>
                    <div className="mt-0.5 text-xs text-slate-400">{t.label} · {whenText(d)}{d.cron ? ` · ${d.cron}` : ''}</div>
                  </div>
                </div>
                {canEdit && (
                  <div className="flex items-center gap-2">
                    <Button variant="subtle" onClick={() => runNow.mutate(d.id)}><Zap className="h-3.5 w-3.5" /> Run now</Button>
                    <Button variant="ghost" onClick={() => toggle.mutate({ id: d.id, enabled: d.enabled })}>
                      {d.enabled ? <><Pause className="h-3.5 w-3.5" /> Pause</> : <><Play className="h-3.5 w-3.5" /> Resume</>}
                    </Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
      {defs.length > 0 && (
        <Pagination
          page={effectivePage}
          pageSize={pageSize}
          total={defs.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      )}
    </div>
  );
}

const FREQUENCIES: { kind: ScheduleKind; label: string }[] = [
  { kind: 'daily', label: 'Every day' },
  { kind: 'weekly', label: 'Every week' },
  { kind: 'monthly', label: 'Every month' },
  { kind: 'hourly', label: 'Every hour' },
  { kind: 'minutely', label: 'Every few minutes' },
  { kind: 'once', label: 'Once, at a set time' },
  { kind: 'cron', label: 'Advanced (cron)' },
];

function CreateForm({ onCreated }: { onCreated: () => void }) {
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: () => api<{ projects: Project[] }>('/projects') });
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const [form, setForm] = useState({ name: '', projectId: '', entity: 'Customer', type: 'bulk_import' as JobType });
  const [sched, setSched] = useState<ScheduleSpec>({ kind: 'daily', time: '09:00', timezone: browserTz, daysOfWeek: [1], dayOfMonth: 1, minute: 0, everyMinutes: 15, cron: '0 9 * * *', runAt: '' });
  const [err, setErr] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const s: ScheduleSpec = { kind: sched.kind, timezone: sched.timezone };
      if (['daily', 'weekly', 'monthly'].includes(sched.kind)) s.time = sched.time;
      if (sched.kind === 'weekly') s.daysOfWeek = sched.daysOfWeek;
      if (sched.kind === 'monthly') s.dayOfMonth = sched.dayOfMonth;
      if (sched.kind === 'hourly') s.minute = sched.minute;
      if (sched.kind === 'minutely') s.everyMinutes = sched.everyMinutes;
      if (sched.kind === 'cron') s.cron = sched.cron;
      if (sched.kind === 'once') s.runAt = sched.runAt ? new Date(sched.runAt).toISOString() : undefined;
      return api('/job-definitions', { method: 'POST', body: { name: form.name, projectId: form.projectId, entity: form.entity, type: form.type, schedule: s } });
    },
    onSuccess: onCreated,
    onError: (e) => setErr(e instanceof Error ? e.message : 'failed'),
  });

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) { setForm((f) => ({ ...f, [k]: v })); }
  function setS<K extends keyof ScheduleSpec>(k: K, v: ScheduleSpec[K]) { setSched((s) => ({ ...s, [k]: v })); }
  function toggleDay(d: number) { setSched((s) => { const days = new Set(s.daysOfWeek ?? []); days.has(d) ? days.delete(d) : days.add(d); return { ...s, daysOfWeek: [...days].sort((a, b) => a - b) }; }); }
  function onSubmit(e: FormEvent) { e.preventDefault(); setErr(null); create.mutate(); }

  return (
    <Card className="p-5">
      <form onSubmit={onSubmit} className="space-y-4">
        <Hint>Pick what to run and when. We'll handle the timing — no technical knowledge needed.</Hint>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Name"><Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Nightly customer import" required /></Field>
          <Field label="Connection"><Select value={form.projectId} onChange={(e) => set('projectId', e.target.value)} required><option value="">Choose a connection…</option>{projects?.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
          <Field label="What to do"><Select value={form.type} onChange={(e) => set('type', e.target.value as JobType)}>{JOB_TYPES.map((t) => <option key={t} value={t}>{typeInfo(t).label}</option>)}</Select></Field>
          <Field label="Record type" hint="The kind of record this works with"><Input value={form.entity} onChange={(e) => set('entity', e.target.value)} /></Field>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="How often"><Select value={sched.kind} onChange={(e) => setS('kind', e.target.value as ScheduleKind)}>{FREQUENCIES.map((f) => <option key={f.kind} value={f.kind}>{f.label}</option>)}</Select></Field>
            {['daily', 'weekly', 'monthly'].includes(sched.kind) && <Field label="At what time"><Input type="time" value={sched.time} onChange={(e) => setS('time', e.target.value)} /></Field>}
            {sched.kind === 'monthly' && <Field label="Day of month"><Input type="number" min={1} max={31} value={sched.dayOfMonth} onChange={(e) => setS('dayOfMonth', Number(e.target.value))} /></Field>}
            {sched.kind === 'hourly' && <Field label="At minute"><Input type="number" min={0} max={59} value={sched.minute} onChange={(e) => setS('minute', Number(e.target.value))} /></Field>}
            {sched.kind === 'minutely' && <Field label="Every N minutes"><Input type="number" min={1} max={59} value={sched.everyMinutes} onChange={(e) => setS('everyMinutes', Number(e.target.value))} /></Field>}
            {sched.kind === 'once' && <Field label="Run at"><Input type="datetime-local" value={sched.runAt} onChange={(e) => setS('runAt', e.target.value)} /></Field>}
            {sched.kind === 'cron' && <Field label="Cron expression" hint="For advanced users"><Input value={sched.cron} onChange={(e) => setS('cron', e.target.value)} placeholder="m h dom mon dow" /></Field>}
            <Field label="Time zone"><Input value={sched.timezone} onChange={(e) => setS('timezone', e.target.value)} /></Field>
          </div>

          {sched.kind === 'weekly' && (
            <div className="mt-3">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">On these days</span>
              <div className="flex flex-wrap gap-1.5">
                {DAY_LABELS.map((d, i) => (
                  <button key={d} type="button" onClick={() => toggleDay(i)} className={`rounded-lg px-3 py-1.5 text-sm transition ${(sched.daysOfWeek ?? []).includes(i) ? 'bg-indigo-600 text-white' : 'border border-slate-300 bg-white text-slate-600 hover:bg-slate-50'}`}>{d}</button>
                ))}
              </div>
            </div>
          )}

          <p className="mt-3 text-sm text-slate-600">
            <span className="font-medium text-slate-800">{humanize(sched)}</span>
            {sched.kind !== 'once' && <span className="ml-2 text-xs text-slate-400">({previewCron(sched)})</span>}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create schedule'}</Button>
          {err && <span className="text-sm text-rose-600">{err}</span>}
        </div>
      </form>
    </Card>
  );
}
