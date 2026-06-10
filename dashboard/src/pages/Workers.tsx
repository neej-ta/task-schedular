import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, RotateCcw } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { typeInfo } from '../labels';
import { Card, PageHeader, Pill, Button } from '../ui';

interface Worker { id: string; pool: string; version: string; status: string; in_flight: number; heartbeat_age_s: number }
interface Queue { name: string; messages: number; messagesReady: number; messagesUnacked: number }

const POOL_LABEL: Record<string, string> = { core: 'Data engine', edge: 'Integration engine' };
function queueLabel(name: string): string {
  const type = name.replace('conductor.q.', '');
  if (name.endsWith('.dlq')) return 'Needs attention (failed tasks)';
  return typeInfo(type).label;
}

export function Workers() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const canOperate = user?.role === 'admin' || user?.role === 'operator';

  const workers = useQuery({ queryKey: ['workers'], queryFn: () => api<{ workers: Worker[] }>('/workers'), refetchInterval: 3000 });
  const queues = useQuery({ queryKey: ['queues'], queryFn: () => api<{ queues: Queue[] }>('/queues'), refetchInterval: 3000 });
  const replay = useMutation({
    mutationFn: () => api<{ replayed: number }>('/dlq/replay', { method: 'POST', body: { max: 100 } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['queues'] }); void qc.invalidateQueries({ queryKey: ['jobs'] }); },
  });

  const dlq = queues.data?.queues.find((q) => q.name.endsWith('.dlq'));
  const workQueues = (queues.data?.queues ?? []).filter((q) => !q.name.endsWith('.dlq') && q.messages > 0);

  return (
    <div>
      <PageHeader title="System" description="The engines that run your tasks, and any work waiting in line. Everything here updates live." />

      <Card className="mb-4 overflow-hidden">
        <div className="border-b border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700">Engines</div>
        {workers.data && workers.data.workers.length === 0 ? (
          <p className="p-4 text-sm text-slate-400">No engines are running right now.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-2">Engine</th><th className="px-4 py-2">Type</th><th className="px-4 py-2">Health</th><th className="px-4 py-2">Working on</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {workers.data?.workers.map((w) => {
                const stale = w.heartbeat_age_s > 30;
                return (
                  <tr key={w.id}>
                    <td className="px-4 py-2.5"><span className="flex items-center gap-2"><Cpu className="h-4 w-4 text-slate-400" /><span className="font-mono text-xs text-slate-600">{w.id.slice(0, 22)}</span></span></td>
                    <td className="px-4 py-2.5 text-slate-600">{POOL_LABEL[w.pool] ?? w.pool}</td>
                    <td className="px-4 py-2.5"><Pill tone={stale ? 'red' : 'green'} dot>{stale ? 'Not responding' : 'Healthy'}</Pill></td>
                    <td className="px-4 py-2.5 text-slate-600">{w.in_flight} task{w.in_flight === 1 ? '' : 's'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {dlq && dlq.messages > 0 && (
        <div className="mb-4">
          <Card className="flex items-center justify-between gap-3 border-rose-200 bg-rose-50/50 p-4">
            <div>
              <p className="font-medium text-rose-800">{dlq.messages} task{dlq.messages === 1 ? '' : 's'} need attention</p>
              <p className="text-sm text-rose-600">These failed after several retries. You can send them back to be tried again.</p>
            </div>
            {canOperate && <Button variant="danger" onClick={() => replay.mutate()}><RotateCcw className="h-4 w-4" />{replay.isPending ? 'Retrying…' : 'Retry all'}</Button>}
          </Card>
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="border-b border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700">Work waiting in line</div>
        {queues.isError ? (
          <p className="p-4 text-sm text-amber-600">Queue stats are temporarily unavailable.</p>
        ) : workQueues.length === 0 ? (
          <p className="p-4 text-sm text-slate-400">Nothing waiting — all caught up. ✨</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-2">Kind of task</th><th className="px-4 py-2">Waiting</th><th className="px-4 py-2">In progress</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {workQueues.map((q) => (
                <tr key={q.name}><td className="px-4 py-2.5 text-slate-700">{queueLabel(q.name)}</td><td className="px-4 py-2.5">{q.messagesReady}</td><td className="px-4 py-2.5">{q.messagesUnacked}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
