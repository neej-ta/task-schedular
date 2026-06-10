// Dashboard-side schedule spec + live preview. The gateway does the
// authoritative ScheduleSpec→cron conversion (@conductor/contracts buildCron);
// this mirror is only for the create-form preview.

export type ScheduleKind = 'daily' | 'weekly' | 'monthly' | 'hourly' | 'minutely' | 'once' | 'cron';

export interface ScheduleSpec {
  kind: ScheduleKind;
  time?: string; // HH:MM
  minute?: number;
  everyMinutes?: number;
  daysOfWeek?: number[]; // 0=Sun..6=Sat
  dayOfMonth?: number;
  cron?: string;
  runAt?: string; // ISO
  timezone: string;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function hm(time?: string): [number, number] {
  const [h, m] = (time ?? '00:00').split(':').map(Number);
  return [h ?? 0, m ?? 0];
}

/** Preview the cron expression the backend will generate (or a one-time note). */
export function previewCron(s: ScheduleSpec): string {
  const [h, m] = hm(s.time);
  switch (s.kind) {
    case 'once':
      return s.runAt ? `once @ ${s.runAt}` : 'pick a date/time';
    case 'minutely':
      return `*/${s.everyMinutes ?? 1} * * * *`;
    case 'hourly':
      return `${s.minute ?? 0} * * * *`;
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekly': {
      const d = (s.daysOfWeek && s.daysOfWeek.length ? s.daysOfWeek : [1]).slice().sort((a, b) => a - b).join(',');
      return `${m} ${h} * * ${d}`;
    }
    case 'monthly':
      return `${m} ${h} ${s.dayOfMonth ?? 1} * *`;
    case 'cron':
      return s.cron || '(enter cron)';
  }
}

export function humanize(s: ScheduleSpec): string {
  switch (s.kind) {
    case 'once':
      return `Once at ${s.runAt ?? '—'}`;
    case 'minutely':
      return `Every ${s.everyMinutes ?? 1} minute(s)`;
    case 'hourly':
      return `Hourly at :${String(s.minute ?? 0).padStart(2, '0')}`;
    case 'daily':
      return `Daily at ${s.time ?? '00:00'}`;
    case 'weekly':
      return `Weekly on ${(s.daysOfWeek && s.daysOfWeek.length ? s.daysOfWeek : [1]).map((d) => DAY_NAMES[d]).join(', ')} at ${s.time ?? '00:00'}`;
    case 'monthly':
      return `Monthly on day ${s.dayOfMonth ?? 1} at ${s.time ?? '00:00'}`;
    case 'cron':
      return `Cron: ${s.cron || '—'}`;
  }
}

export const DAY_LABELS = DAY_NAMES;
