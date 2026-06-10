import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ListChecks } from 'lucide-react';
import { api } from '../api';
import type { Job } from '../types';
import { typeInfo, statusInfo } from '../labels';
import { Card, EmptyState, Input, PageHeader, Pill, Select } from '../ui';

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function Jobs({ onOpenJob }: { onOpenJob: (id: string) => void }) {
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['jobs', status, type, q],
    queryFn: () => {
      const p = new URLSearchParams();
      if (status) p.set('status', status);
      if (type) p.set('type', type);
      if (q) p.set('q', q);
      return api<{ jobs: Job[]; total: number }>(`/jobs?${p.toString()}`);
    },
    refetchInterval: 15000,
  });

  return (
    <div>
      <PageHeader
        title="Tasks"
        description="Every piece of background work Conductor runs — importing, exporting, updating, or syncing your data. Click any task to watch it live."
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <Input placeholder="Search tasks…" value={q} onChange={(e) => setQ(e.target.value)} className="w-48" />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44">
          <option value="">Any status</option>
          <option value="queued">Waiting</option>
          <option value="running">Running</option>
          <option value="completed">Done</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </Select>
        <Select value={type} onChange={(e) => setType(e.target.value)} className="w-52">
          <option value="">Any kind</option>
          {Object.entries({ bulk_import: 'Import data', bulk_update: 'Update records', bulk_delete: 'Delete records', rest_pull: 'Import from API', rest_push: 'Send to API' }).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </Select>
      </div>

      {isLoading && <p className="text-slate-400">Loading…</p>}
      {error && <p className="text-rose-600">{(error as Error).message}</p>}

      {data && data.jobs.length === 0 ? (
        <EmptyState icon={<ListChecks className="h-10 w-10" />} title="No tasks yet">
          Tasks appear here when you run something. Head to <b>Schedules</b> and press <b>Run now</b> on any
          task to see it in action.
        </EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5">What it does</th>
                <th className="px-4 py-2.5">Data</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Started</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data?.jobs.map((j) => {
                const t = typeInfo(j.type);
                const s = statusInfo(j.status);
                const Icon = t.icon;
                return (
                  <tr key={j.id} onClick={() => onOpenJob(j.id)} className="cursor-pointer hover:bg-indigo-50/40">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                          <Icon className="h-4 w-4" />
                        </span>
                        <div>
                          <div className="font-medium text-slate-800">{t.label}</div>
                          <div className="text-xs text-slate-400">{t.blurb}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{j.entity}</td>
                    <td className="px-4 py-3"><Pill tone={s.tone} dot={j.status === 'running'} title={s.help}>{s.label}</Pill></td>
                    <td className="px-4 py-3 text-slate-500">{timeAgo(j.queued_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      <p className="mt-3 text-xs text-slate-400">Updates live — no need to refresh.</p>
    </div>
  );
}
