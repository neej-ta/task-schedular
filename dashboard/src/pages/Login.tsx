import { useState, type FormEvent } from 'react';
import { Waypoints } from 'lucide-react';
import { useAuth } from '../auth';
import { Button, Card, Field, Input } from '../ui';

export function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('admin@conductor.local');
  const [password, setPassword] = useState('admin123');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-sm">
            <Waypoints className="h-6 w-6" />
          </span>
          <h1 className="text-2xl font-semibold text-slate-900">Welcome to Conductor</h1>
          <p className="text-sm text-slate-500">Sign in to run and watch your background tasks.</p>
        </div>
        <Card className="p-6">
          <form onSubmit={onSubmit} className="space-y-4">
            <Field label="Email">
              <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoFocus />
            </Field>
            <Field label="Password">
              <Input value={password} onChange={(e) => setPassword(e.target.value)} type="password" />
            </Field>
            {error && (
              <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy} className="w-full justify-center">
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </Card>
        <p className="mt-4 text-center text-xs text-slate-400">
          Demo sign-in: admin@conductor.local · admin123
        </p>
      </div>
    </div>
  );
}
