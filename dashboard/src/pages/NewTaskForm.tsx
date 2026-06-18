import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Zap } from 'lucide-react';
import { api } from '../api';
import type { JobType, Project } from '../types';
import { typeInfo } from '../labels';
import { Button, Card, Field, Hint, Input, Select } from '../ui';

const JOB_TYPES: JobType[] = [
  'bulk_import', 'bulk_insert', 'bulk_update', 'bulk_delete',
  'file_inbound', 'file_outbound', 'xml_integration', 'rest_pull', 'rest_push',
];

// Start a one-off task right now without first saving a schedule. Mirrors the
// fields the Schedules "New schedule" form collects, minus the recurrence —
// it enqueues immediately via POST /jobs (the same ad-hoc path Import uses).
export function NewTaskForm({ onCreated }: { onCreated: (jobId: string | null) => void }) {
  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api<{ projects: Project[] }>('/projects'),
  });
  const [form, setForm] = useState({ projectId: '', entity: 'Customer', type: 'bulk_import' as JobType, priority: 5 });
  const [err, setErr] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api<{ enqueued: boolean; jobId: string | null }>('/jobs', {
        method: 'POST',
        body: { projectId: form.projectId, entity: form.entity.trim(), type: form.type, priority: form.priority },
      }),
    onSuccess: (r) => onCreated(r.jobId),
    onError: (e) => setErr(e instanceof Error ? e.message : 'failed'),
  });

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!form.projectId) return setErr('Pick a connection to run this on.');
    if (!form.entity.trim()) return setErr('Give this task a record type.');
    create.mutate();
  }

  return (
    <Card className="p-5">
      <form onSubmit={onSubmit} className="space-y-4">
        <Hint>Start a one-off task right now — no schedule needed. It begins as soon as a worker is free.</Hint>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Connection">
            <Select value={form.projectId} onChange={(e) => set('projectId', e.target.value)} required>
              <option value="">Choose a connection…</option>
              {projects?.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="What to do">
            <Select value={form.type} onChange={(e) => set('type', e.target.value as JobType)}>
              {JOB_TYPES.map((t) => <option key={t} value={t}>{typeInfo(t).label}</option>)}
            </Select>
          </Field>
          <Field label="Record type" hint="The kind of record this works with">
            <Input value={form.entity} onChange={(e) => set('entity', e.target.value)} />
          </Field>
          <Field label="Priority" hint="0 = first in line, 9 = last">
            <Input type="number" min={0} max={9} value={form.priority} onChange={(e) => set('priority', Number(e.target.value))} />
          </Field>
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={create.isPending || !form.projectId}>
            <Zap className="h-4 w-4" /> {create.isPending ? 'Starting…' : 'Create task'}
          </Button>
          {err && <span className="text-sm text-rose-600">{err}</span>}
        </div>
      </form>
    </Card>
  );
}
