import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Standard scheduler recurrence presets (daily / weekly / monthly / hourly /
// every-N-minutes / one-time / raw cron) — so a non-developer operator never has
// to write a cron string. `buildCron` lowers a ScheduleSpec to the stored cron +
// schedule_kind that the scheduler already understands. Single source of truth,
// unit-tested, shared by gateway + dashboard.
// ─────────────────────────────────────────────────────────────────────────────

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/; // HH:MM 24h

export const ScheduleSpecSchema = z
  .object({
    kind: z.enum(['once', 'minutely', 'hourly', 'daily', 'weekly', 'monthly', 'cron']),
    time: z.string().regex(TIME_RE).optional(), // HH:MM for daily/weekly/monthly
    minute: z.number().int().min(0).max(59).optional(), // for hourly
    everyMinutes: z.number().int().min(1).max(1440).optional(), // for minutely/interval
    daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(), // 0=Sun..6=Sat
    dayOfMonth: z.number().int().min(1).max(31).optional(), // for monthly
    cron: z.string().optional(), // raw cron passthrough
    runAt: z.string().datetime().optional(), // ISO, for one-time
    timezone: z.string().default('UTC'),
  })
  .strict();
export type ScheduleSpec = z.infer<typeof ScheduleSpecSchema>;

export interface BuiltSchedule {
  scheduleKind: 'cron' | 'one_time' | 'recurring';
  cron: string | null;
  runAt: string | null;
  timezone: string;
}

function hhmm(time?: string): { h: number; m: number } {
  const [h, m] = (time ?? '00:00').split(':').map(Number);
  return { h: h ?? 0, m: m ?? 0 };
}

/** Lower a friendly ScheduleSpec to a stored cron expression + schedule kind. */
export function buildCron(spec: ScheduleSpec): BuiltSchedule {
  const tz = spec.timezone ?? 'UTC';
  switch (spec.kind) {
    case 'once':
      if (!spec.runAt) throw new Error('one-time schedule requires runAt');
      return { scheduleKind: 'one_time', cron: null, runAt: spec.runAt, timezone: tz };

    case 'minutely': {
      const n = spec.everyMinutes ?? 1;
      if (n < 1 || n > 59) throw new Error('everyMinutes must be 1..59 for a minutely schedule');
      return { scheduleKind: 'recurring', cron: `*/${n} * * * *`, runAt: null, timezone: tz };
    }

    case 'hourly': {
      const m = spec.minute ?? 0;
      return { scheduleKind: 'recurring', cron: `${m} * * * *`, runAt: null, timezone: tz };
    }

    case 'daily': {
      const { h, m } = hhmm(spec.time);
      return { scheduleKind: 'cron', cron: `${m} ${h} * * *`, runAt: null, timezone: tz };
    }

    case 'weekly': {
      const { h, m } = hhmm(spec.time);
      const days = spec.daysOfWeek && spec.daysOfWeek.length > 0 ? spec.daysOfWeek : [1]; // default Mon
      const dow = [...new Set(days)].sort((a, b) => a - b).join(',');
      return { scheduleKind: 'cron', cron: `${m} ${h} * * ${dow}`, runAt: null, timezone: tz };
    }

    case 'monthly': {
      const { h, m } = hhmm(spec.time);
      const dom = spec.dayOfMonth ?? 1;
      return { scheduleKind: 'cron', cron: `${m} ${h} ${dom} * *`, runAt: null, timezone: tz };
    }

    case 'cron':
      if (!spec.cron) throw new Error('cron schedule requires a cron expression');
      return { scheduleKind: 'cron', cron: spec.cron, runAt: null, timezone: tz };

    default:
      throw new Error(`unknown schedule kind: ${(spec as { kind: string }).kind}`);
  }
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? 'th'}`;
}

/** Human-readable summary for the dashboard (e.g. "Weekly on Mon, Wed at 09:00 (UTC)"). */
export function humanizeSchedule(spec: ScheduleSpec): string {
  const tz = spec.timezone ?? 'UTC';
  switch (spec.kind) {
    case 'once':
      return `Once at ${spec.runAt ?? '—'}`;
    case 'minutely':
      return `Every ${spec.everyMinutes ?? 1} minute(s)`;
    case 'hourly':
      return `Hourly at :${String(spec.minute ?? 0).padStart(2, '0')} (${tz})`;
    case 'daily':
      return `Daily at ${spec.time ?? '00:00'} (${tz})`;
    case 'weekly': {
      const days = (spec.daysOfWeek && spec.daysOfWeek.length ? spec.daysOfWeek : [1])
        .map((d) => DAY_NAMES[d] ?? '?')
        .join(', ');
      return `Weekly on ${days} at ${spec.time ?? '00:00'} (${tz})`;
    }
    case 'monthly':
      return `Monthly on the ${ordinal(spec.dayOfMonth ?? 1)} at ${spec.time ?? '00:00'} (${tz})`;
    case 'cron':
      return `Cron \`${spec.cron}\` (${tz})`;
    default:
      return 'Unknown schedule';
  }
}
