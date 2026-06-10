import { useEffect, useState } from 'react';
import { Activity as ActivityIcon } from 'lucide-react';
import { api } from '../api';
import { useEventSource } from '../sse';
import type { ActivityEvent } from '../types';
import { Card, EmptyState, PageHeader, Pill } from '../ui';
import type { Tone } from '../labels';

const EVENT: Record<string, { label: string; tone: Tone }> = {
  'job.queued': { label: 'Task queued', tone: 'amber' },
  'job.started': { label: 'Task started', tone: 'blue' },
  'job.completed': { label: 'Task finished', tone: 'green' },
  'job.failed': { label: 'Task failed', tone: 'red' },
  'job.retrying': { label: 'Task retrying', tone: 'blue' },
  'job.cancelling': { label: 'Stop requested', tone: 'slate' },
  'job.cancelled': { label: 'Task stopped', tone: 'slate' },
  'project.create': { label: 'Connection added', tone: 'green' },
};

const FILTERS: [string, string][] = [['', 'Everything'], ['job.', 'Tasks only'], ['completed', 'Finished'], ['failed', 'Failed']];

export function Activity({ onOpenJob }: { onOpenJob: (id: string) => void }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => { api<{ activity: ActivityEvent[] }>('/activity').then((r) => setEvents(r.activity)); }, []);
  useEventSource('/activity/stream', { activity: (d) => setEvents((p) => [d as ActivityEvent, ...p].slice(0, 500)) });

  const filtered = events.filter((e) => !filter || e.type.includes(filter));

  return (
    <div>
      <PageHeader
        title="Activity"
        description="A live feed of everything happening across Conductor — tasks starting, finishing, retrying, and more — newest first."
      />
      <div className="mb-4 flex gap-2">
        {FILTERS.map(([v, l]) => (
          <button key={v} onClick={() => setFilter(v)} className={`rounded-lg px-3 py-1.5 text-sm transition ${filter === v ? 'bg-indigo-50 text-indigo-700' : 'text-slate-500 hover:bg-slate-100'}`}>{l}</button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={<ActivityIcon className="h-10 w-10" />} title="Nothing's happened yet">
          Run a task and you'll see it show up here instantly.
        </EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <ol className="divide-y divide-slate-100">
            {filtered.map((e, i) => {
              const info = EVENT[e.type] ?? { label: e.type, tone: 'slate' as Tone };
              return (
                <li key={i} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50">
                  <span className="w-20 shrink-0 text-xs text-slate-400">{new Date(e.ts).toLocaleTimeString()}</span>
                  <Pill tone={info.tone}>{info.label}</Pill>
                  <span className="flex-1 text-sm text-slate-600">{e.message}</span>
                  {e.jobId && <button onClick={() => onOpenJob(e.jobId!)} className="text-xs font-medium text-indigo-600 hover:underline">View task →</button>}
                </li>
              );
            })}
          </ol>
        </Card>
      )}
    </div>
  );
}
