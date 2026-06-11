import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Activity as ActivityIcon,
  BarChart3,
  CalendarClock,
  Database,
  ListChecks,
  LogOut,
  Server,
  Upload,
  Waypoints,
} from 'lucide-react';
import { useAuth } from './auth';
import { useEventSource } from './sse';
import { Login } from './pages/Login';
import { Projects } from './pages/Projects';
import { Schedules } from './pages/Schedules';
import { Jobs } from './pages/Jobs';
import { JobDetail } from './pages/JobDetail';
import { Activity } from './pages/Activity';
import { Workers } from './pages/Workers';
import { Metrics } from './pages/Metrics';
import { ImportData } from './pages/ImportData';
import { Pill } from './ui';

type Key = 'jobs' | 'import' | 'schedules' | 'projects' | 'activity' | 'workers' | 'metrics';
const NAV: { key: Key; label: string; icon: typeof ListChecks }[] = [
  { key: 'jobs', label: 'Tasks', icon: ListChecks },
  { key: 'import', label: 'Import', icon: Upload },
  { key: 'schedules', label: 'Schedules', icon: CalendarClock },
  { key: 'projects', label: 'Connections', icon: Database },
  { key: 'activity', label: 'Activity', icon: ActivityIcon },
  { key: 'workers', label: 'System', icon: Server },
  { key: 'metrics', label: 'Insights', icon: BarChart3 },
];

export function App() {
  const { user, loading, logout } = useAuth();
  const qc = useQueryClient();
  const [page, setPage] = useState<Key>('jobs');
  const [jobId, setJobId] = useState<string | null>(null);

  // App-level activity stream drives the "Live" badge and keeps lists fresh.
  const connected = useEventSource(user ? '/activity/stream' : null, {
    activity: () => {
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void qc.invalidateQueries({ queryKey: ['definitions'] });
    },
  });

  if (loading) return <div className="p-8 text-slate-400">Loading…</div>;
  if (!user) return <Login />;

  const goJob = (id: string) => { setJobId(id); setPage('jobs'); };

  function renderPage() {
    if (jobId && page === 'jobs') return <JobDetail jobId={jobId} onBack={() => setJobId(null)} />;
    switch (page) {
      case 'jobs': return <Jobs onOpenJob={(id) => setJobId(id)} />;
      case 'import': return <ImportData onOpenJob={goJob} />;
      case 'schedules': return <Schedules onOpenJob={goJob} />;
      case 'projects': return <Projects />;
      case 'activity': return <Activity onOpenJob={goJob} />;
      case 'workers': return <Workers />;
      case 'metrics': return <Metrics />;
    }
  }

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-slate-200 bg-white/90 backdrop-blur">
        <div className="flex items-center gap-2 px-5 py-4">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-white">
            <Waypoints className="h-4 w-4" />
          </span>
          <span className="text-base font-semibold text-slate-900">Conductor</span>
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-2">
          {NAV.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => { setPage(key); setJobId(null); }}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
                page === key ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </nav>
        <div className="border-t border-slate-200 px-3 py-3">
          <Pill tone={connected ? 'green' : 'slate'} dot title="Live updates from the server">
            {connected ? 'Live' : 'Offline'}
          </Pill>
          <div className="mt-3 flex items-center justify-between gap-2 text-sm">
            <div className="min-w-0">
              <div className="truncate font-medium text-slate-700">{user.email}</div>
              <div className="text-xs capitalize text-slate-400">{user.role}</div>
            </div>
            <button onClick={logout} title="Sign out" className="shrink-0 rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>
      <main className="flex-1 overflow-x-hidden">
        <div className="mx-auto max-w-6xl p-6">{renderPage()}</div>
      </main>
    </div>
  );
}
