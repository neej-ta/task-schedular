import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, ChevronRight, Download } from 'lucide-react';
import { api, fetchText, fetchBlob } from '../api';
import { useAuth } from '../auth';
import { useEventSource } from '../sse';
import type { Job, JobChunk, JobErrorRow, JobEventRow, JobLog, Progress } from '../types';
import { typeInfo, statusInfo } from '../labels';
import { Button, Card, Pill } from '../ui';

const CHUNK_COLOR: Record<string, string> = {
  pending: 'bg-slate-200', running: 'bg-blue-400 animate-pulse', completed: 'bg-emerald-400', failed: 'bg-rose-400',
};
const LEVEL_COLOR: Record<string, string> = {
  trace: 'text-slate-400', debug: 'text-slate-400', info: 'text-slate-600', warn: 'text-amber-600', error: 'text-rose-600',
};
const EVENT_LABEL: Record<string, string> = {
  'job.queued': 'Added to the queue', 'job.started': 'Started working', 'job.completed': 'Finished successfully',
  'job.failed': 'Failed', 'job.retrying': 'Retrying after a snag', 'job.cancelling': 'Stop requested', 'job.cancelled': 'Stopped',
};

function summarize(j: Job): { src: string; dest: string } {
  const s = j.source_jsonb ?? {};
  const d = j.destination_jsonb ?? {};
  const src = s.location ? `${String(s.kind ?? 'file').toUpperCase()} · ${s.location}` : String(s.kind ?? '—');
  const dest = d.table ? `Database table “${d.table}”` : d.location ? String(d.location) : String(d.kind ?? '—');
  return { src, dest };
}

export function JobDetail({ jobId, onBack }: { jobId: string; onBack: () => void }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const canOperate = user?.role === 'admin' || user?.role === 'operator';

  const job = useQuery({ queryKey: ['job', jobId], queryFn: () => api<{ job: Job }>(`/jobs/${jobId}`) });
  const chunks = useQuery({ queryKey: ['chunks', jobId], queryFn: () => api<{ chunks: JobChunk[] }>(`/jobs/${jobId}/chunks`) });
  const errors = useQuery({ queryKey: ['errors', jobId], queryFn: () => api<{ errors: JobErrorRow[] }>(`/jobs/${jobId}/errors`) });
  const events = useQuery({ queryKey: ['events', jobId], queryFn: () => api<{ events: JobEventRow[] }>(`/jobs/${jobId}/events`) });

  const [logs, setLogs] = useState<JobLog[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [showTech, setShowTech] = useState(false);
  const seen = useRef<Set<number>>(new Set());

  useEffect(() => {
    setLogs([]); seen.current = new Set();
    api<{ logs: JobLog[] }>(`/jobs/${jobId}/logs`).then((r) => {
      const fresh = r.logs.filter((l) => !seen.current.has(l.id));
      fresh.forEach((l) => seen.current.add(l.id));
      setLogs((p) => [...p, ...fresh]);
    });
  }, [jobId]);

  const connected = useEventSource(`/jobs/${jobId}/stream`, {
    log: (d) => { const l = d as JobLog; if (seen.current.has(l.id)) return; seen.current.add(l.id); setLogs((p) => [...p, l]); },
    progress: (d) => setProgress(d as Progress),
    state: () => {
      void qc.invalidateQueries({ queryKey: ['job', jobId] });
      void qc.invalidateQueries({ queryKey: ['chunks', jobId] });
      void qc.invalidateQueries({ queryKey: ['errors', jobId] });
      void qc.invalidateQueries({ queryKey: ['events', jobId] });
    },
  });

  const cancel = useMutation({ mutationFn: () => api(`/jobs/${jobId}/cancel`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['job', jobId] }) });
  const retry = useMutation({ mutationFn: () => api<{ jobId: string }>(`/jobs/${jobId}/retry`, { method: 'POST' }) });

  const j = job.data?.job;
  const status = j?.status ?? 'unknown';
  const s = statusInfo(status);
  const t = j ? typeInfo(j.type) : null;
  const terminal = ['completed', 'failed', 'cancelled'].includes(status);

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4" /> Back to tasks
      </button>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {t && <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600"><t.icon className="h-5 w-5" /></span>}
          <div>
            <h1 className="text-lg font-semibold text-slate-900">{t?.label ?? 'Task'}</h1>
            <p className="text-xs text-slate-400">{t?.blurb}</p>
          </div>
          <Pill tone={s.tone} dot={status === 'running'} title={s.help}>{s.label}</Pill>
          <span className="flex items-center gap-1 text-xs text-slate-400">
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-slate-300'}`} />
            {connected ? 'live' : 'offline'}
          </span>
        </div>
        {canOperate && (
          <div className="flex gap-2">
            {!terminal && <Button variant="danger" onClick={() => cancel.mutate()}>Stop task</Button>}
            {terminal && <Button onClick={() => retry.mutate()}>{retry.isSuccess ? 'Started again ✓' : 'Run again'}</Button>}
          </div>
        )}
      </div>

      {j && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card className="p-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">Progress</h3>
            <ProgressView progress={progress} job={j} />
          </Card>
          <Card className="p-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">What this task is doing</h3>
            <dl className="space-y-1.5 text-sm">
              <Row k="Reads from" v={summarize(j).src} />
              <Row k="Writes to" v={summarize(j).dest} />
              <Row k="Record type" v={j.entity} />
            </dl>
            <button onClick={() => setShowTech((v) => !v)} className="mt-3 inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600">
              {showTech ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} Technical details
            </button>
            {showTech && (
              <pre className="mt-2 overflow-auto rounded-lg bg-slate-50 p-2 text-[11px] leading-relaxed text-slate-600">
{JSON.stringify({ id: j.id, type: j.type, idempotency_key: j.idempotency_key, worker: j.worker_id, attempt: j.attempt, source: j.source_jsonb, destination: j.destination_jsonb }, null, 2)}
              </pre>
            )}
          </Card>
        </div>
      )}

      <Card className="p-4">
        <h3 className="mb-1 text-sm font-semibold text-slate-700">Chunks</h3>
        <p className="mb-2 text-xs text-slate-400">Big jobs are split into small chunks that run in parallel. Each square is one chunk.</p>
        <div className="flex flex-wrap gap-1">
          {chunks.data?.chunks.map((c) => (
            <div key={c.chunk_index} title={`Chunk ${c.chunk_index}: ${c.status} — ${c.processed_count} rows`} className={`h-5 w-5 rounded ${CHUNK_COLOR[c.status] ?? 'bg-slate-200'}`} />
          ))}
          {(chunks.data?.chunks.length ?? 0) === 0 && <span className="text-xs text-slate-400">No chunks yet.</span>}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <LiveLogs logs={logs} />
        <Errors jobId={jobId} errors={errors.data?.errors ?? []} />
      </div>

      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">Timeline</h3>
        <ol className="space-y-2">
          {events.data?.events.map((e, i) => (
            <li key={i} className="flex items-start gap-3 text-sm">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-indigo-300" />
              <span className="w-20 shrink-0 text-xs text-slate-400">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className="font-medium text-slate-700">{EVENT_LABEL[e.type] ?? e.type}</span>
              <span className="text-slate-500">{e.message}</span>
            </li>
          ))}
          {(events.data?.events.length ?? 0) === 0 && <li className="text-sm text-slate-400">Nothing yet.</li>}
        </ol>
      </Card>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-slate-400">{k}</dt>
      <dd className="break-all font-medium text-slate-700">{v}</dd>
    </div>
  );
}

function ProgressView({ progress, job }: { progress: Progress | null; job: Job }) {
  const total = progress?.total ?? 0;
  const processed = progress?.processed ?? 0;
  const errors = progress?.errors ?? 0;
  const done = processed + errors;
  const pct = total > 0 ? Math.round((done / total) * 100) : job.status === 'completed' ? 100 : 0;
  const throughput = useMemo(() => {
    if (!job.started_at) return null;
    const end = job.finished_at ? new Date(job.finished_at).getTime() : Date.now();
    const secs = Math.max(0.001, (end - new Date(job.started_at).getTime()) / 1000);
    return Math.round(done / secs);
  }, [done, job.started_at, job.finished_at]);

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-2xl font-semibold text-slate-900">{pct}%</span>
        <span className="text-sm text-slate-500">{done.toLocaleString()}{total ? ` of ${total.toLocaleString()}` : ''} rows{throughput ? ` · ${throughput}/s` : ''}</span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-3 flex gap-4 text-sm">
        <span className="text-emerald-600">{processed.toLocaleString()} imported</span>
        <span className="text-rose-600">{errors.toLocaleString()} skipped</span>
        {(progress?.chunksRemaining ?? 0) > 0 && <span className="text-slate-400">{progress?.chunksRemaining} chunks left</span>}
      </div>
    </div>
  );
}

function LiveLogs({ logs }: { logs: JobLog[] }) {
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (follow && box.current) box.current.scrollTop = box.current.scrollHeight; }, [logs.length, follow]);
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
        <h3 className="text-sm font-semibold text-slate-700">Live activity log</h3>
        <button onClick={() => setFollow((f) => !f)} className={`rounded-md px-2 py-1 text-xs ${follow ? 'bg-indigo-50 text-indigo-700' : 'border border-slate-200 text-slate-500'}`}>
          {follow ? 'Following' : 'Paused'}
        </button>
      </div>
      <div ref={box} className="h-64 overflow-auto bg-slate-50/60 p-3 font-mono text-xs leading-relaxed">
        {logs.map((l) => (
          <div key={l.id} className="whitespace-pre-wrap">
            <span className="text-slate-400">{new Date(l.ts).toLocaleTimeString()} </span>
            <span className={LEVEL_COLOR[l.level] ?? 'text-slate-600'}>{l.message}</span>
          </div>
        ))}
        {logs.length === 0 && <div className="text-slate-400">Waiting for activity…</div>}
      </div>
    </Card>
  );
}

function Errors({ jobId, errors }: { jobId: string; errors: JobErrorRow[] }) {
  // Download the WHOLE file annotated with OK/REJECTED + reason from the server.
  // Fall back to a reasons-only CSV from what's loaded if the file isn't there
  // (e.g. an older job that predates the annotated-file feature).
  async function exportCsv() {
    const download = (text: string, name: string) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
      a.download = name;
      a.click();
    };
    try {
      download(await fetchText(`/jobs/${jobId}/rejects.csv`), `task-${jobId.slice(0, 8)}-rows.csv`);
    } catch {
      const body = 'row,field,value,reason\n' + errors.map((e) => `${e.row_number},${e.field ?? ''},"${String(e.raw?.[e.field ?? ''] ?? '').replace(/"/g, '""')}","${e.message.replace(/"/g, '""')}"`).join('\n');
      download(body, `task-${jobId.slice(0, 8)}-skipped-rows.csv`);
    }
  }
  // Excel variant: the whole file with each REJECTED row's failing cell(s)
  // highlighted red + a _status/_reason pair, so the user sees exactly which
  // field broke its project rule, fixes it in place, and re-imports.
  async function exportXlsx() {
    const blob = await fetchBlob(`/jobs/${jobId}/rejects.xlsx`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `task-${jobId.slice(0, 8)}-rows.xlsx`;
    a.click();
  }
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
        <h3 className="text-sm font-semibold text-slate-700">Skipped rows {errors.length > 0 && <span className="text-slate-400">({errors.length})</span>}</h3>
        {errors.length > 0 && (
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" onClick={exportCsv}><Download className="h-3.5 w-3.5" /> CSV</Button>
            <Button variant="ghost" onClick={exportXlsx}><Download className="h-3.5 w-3.5" /> Excel (highlighted)</Button>
          </div>
        )}
      </div>
      <div className="h-64 overflow-auto">
        {errors.length === 0 ? (
          <p className="p-4 text-sm text-slate-400">No rows were skipped — everything imported cleanly. 🎉</p>
        ) : (
          <>
            <p className="border-b border-slate-100 bg-amber-50/60 px-3 py-2 text-[11px] leading-relaxed text-amber-700">
              The download is your whole file with each row marked <span className="font-semibold">OK</span> or <span className="font-semibold">REJECTED</span> and why. Fix the rejected rows and re-import from the Import screen — rows that already imported are skipped automatically.
            </p>
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white text-left text-slate-400">
                <tr><th className="px-3 py-1.5">Row</th><th className="px-3 py-1.5">Field</th><th className="px-3 py-1.5">Value</th><th className="px-3 py-1.5">Why it was rejected</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {errors.map((e, i) => (
                  <tr key={i}>
                    <td className="px-3 py-1.5 text-slate-500">{e.row_number}</td>
                    <td className="px-3 py-1.5 font-medium text-slate-700">{e.field ?? '—'}</td>
                    <td className="px-3 py-1.5 font-mono text-rose-600">{e.field && e.raw ? String(e.raw[e.field] ?? '') : '—'}</td>
                    <td className="px-3 py-1.5 text-slate-600">{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </Card>
  );
}
