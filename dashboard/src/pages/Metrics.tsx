import { useQuery } from '@tanstack/react-query';
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { api, API_BASE } from '../api';
import { typeInfo, statusInfo } from '../labels';
import { Card, PageHeader } from '../ui';

interface Summary {
  byStatus: { status: string; n: number }[];
  byType: { type: string; n: number }[];
  throughput: { minute: string; n: number }[];
  duration: { type: string; avg_s: number; p95_s: number }[];
}
const TONE_HEX: Record<string, string> = { amber: '#f59e0b', blue: '#3b82f6', green: '#10b981', red: '#ef4444', slate: '#94a3b8' };
const tipStyle = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12 };

export function Metrics() {
  const { data } = useQuery({ queryKey: ['metrics-summary'], queryFn: () => api<Summary>('/metrics/summary'), refetchInterval: 5000 });
  const byStatus = data?.byStatus ?? [];
  const total = byStatus.reduce((s, x) => s + x.n, 0);
  const count = (st: string) => byStatus.find((x) => x.status === st)?.n ?? 0;

  const tiles = [
    { label: 'Total tasks', value: total, tone: 'slate' },
    { label: 'Done', value: count('completed'), tone: 'green' },
    { label: 'Running', value: count('running') + count('retrying'), tone: 'blue' },
    { label: 'Failed', value: count('failed'), tone: 'red' },
  ];

  return (
    <div>
      <PageHeader
        title="Insights"
        description="A bird's-eye view of how your tasks are doing — how many run, how fast, and how often they succeed."
        actions={<a href={`${API_BASE}/metrics`} target="_blank" rel="noreferrer" className="text-xs text-slate-400 hover:text-slate-600">raw metrics · Grafana :3001 →</a>}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label} className="p-4">
            <div className="text-2xl font-semibold" style={{ color: TONE_HEX[t.tone] }}>{t.value.toLocaleString()}</div>
            <div className="text-sm text-slate-500">{t.label}</div>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">Tasks finished per minute (last hour)</h3>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={data?.throughput ?? []}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
              <XAxis dataKey="minute" stroke="#94a3b8" fontSize={11} />
              <YAxis stroke="#94a3b8" fontSize={11} allowDecimals={false} />
              <Tooltip contentStyle={tipStyle} />
              <Line type="monotone" dataKey="n" stroke="#6366f1" strokeWidth={2} dot={false} name="tasks" />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">How tasks ended up</h3>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={byStatus} dataKey="n" nameKey="status" outerRadius={80} label={(e) => `${statusInfo(e.status).label}: ${e.n}`}>
                {byStatus.map((s) => <Cell key={s.status} fill={TONE_HEX[statusInfo(s.status).tone]} />)}
              </Pie>
              <Tooltip contentStyle={tipStyle} />
            </PieChart>
          </ResponsiveContainer>
        </Card>

        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">Most common kinds of task</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={(data?.byType ?? []).map((d) => ({ ...d, label: typeInfo(d.type).label }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
              <XAxis dataKey="label" stroke="#94a3b8" fontSize={10} angle={-20} textAnchor="end" height={64} interval={0} />
              <YAxis stroke="#94a3b8" fontSize={11} allowDecimals={false} />
              <Tooltip contentStyle={tipStyle} />
              <Bar dataKey="n" fill="#6366f1" name="tasks" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">How long tasks take (seconds)</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={(data?.duration ?? []).map((d) => ({ ...d, label: typeInfo(d.type).label }))}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
              <XAxis dataKey="label" stroke="#94a3b8" fontSize={10} angle={-20} textAnchor="end" height={64} interval={0} />
              <YAxis stroke="#94a3b8" fontSize={11} />
              <Tooltip contentStyle={tipStyle} />
              <Bar dataKey="avg_s" fill="#38bdf8" name="typical" radius={[4, 4, 0, 0]} />
              <Bar dataKey="p95_s" fill="#f59e0b" name="slowest 5%" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>
    </div>
  );
}
