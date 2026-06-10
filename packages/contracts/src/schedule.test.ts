import { test } from 'node:test';
import assert from 'node:assert/strict';
import parser from 'cron-parser';
import { buildCron, humanizeSchedule, ScheduleSpecSchema, type ScheduleSpec } from './schedule.js';

function cronOf(spec: ScheduleSpec): string {
  const built = buildCron(ScheduleSpecSchema.parse(spec));
  // Every generated cron must be parseable.
  if (built.cron) parser.parseExpression(built.cron, { tz: built.timezone });
  return built.cron ?? '';
}

test('daily at 09:30 → "30 9 * * *"', () => {
  assert.equal(cronOf({ kind: 'daily', time: '09:30', timezone: 'UTC' }), '30 9 * * *');
});

test('weekly Mon/Wed/Fri at 08:00 → "0 8 * * 1,3,5"', () => {
  assert.equal(cronOf({ kind: 'weekly', time: '08:00', daysOfWeek: [1, 3, 5], timezone: 'UTC' }), '0 8 * * 1,3,5');
});

test('weekly dedupes + sorts days', () => {
  assert.equal(cronOf({ kind: 'weekly', time: '00:00', daysOfWeek: [5, 1, 5, 3], timezone: 'UTC' }), '0 0 * * 1,3,5');
});

test('monthly on the 15th at 06:45 → "45 6 15 * *"', () => {
  assert.equal(cronOf({ kind: 'monthly', time: '06:45', dayOfMonth: 15, timezone: 'UTC' }), '45 6 15 * *');
});

test('hourly at minute 15 → "15 * * * *"', () => {
  assert.equal(cronOf({ kind: 'hourly', minute: 15, timezone: 'UTC' }), '15 * * * *');
});

test('every 5 minutes → "*/5 * * * *"', () => {
  assert.equal(cronOf({ kind: 'minutely', everyMinutes: 5, timezone: 'UTC' }), '*/5 * * * *');
});

test('raw cron passthrough is validated', () => {
  assert.equal(cronOf({ kind: 'cron', cron: '0 0 1 1 *', timezone: 'UTC' }), '0 0 1 1 *');
});

test('one-time yields one_time kind + runAt, no cron', () => {
  const built = buildCron(ScheduleSpecSchema.parse({ kind: 'once', runAt: '2026-07-01T09:00:00Z', timezone: 'UTC' }));
  assert.equal(built.scheduleKind, 'one_time');
  assert.equal(built.cron, null);
  assert.equal(built.runAt, '2026-07-01T09:00:00Z');
});

test('daily defaults to midnight when no time given', () => {
  assert.equal(cronOf({ kind: 'daily', timezone: 'UTC' }), '0 0 * * *');
});

test('schema rejects a malformed time', () => {
  assert.throws(() => ScheduleSpecSchema.parse({ kind: 'daily', time: '25:00' }));
});

test('humanize is readable', () => {
  assert.equal(
    humanizeSchedule(ScheduleSpecSchema.parse({ kind: 'weekly', time: '09:00', daysOfWeek: [1, 3], timezone: 'UTC' })),
    'Weekly on Mon, Wed at 09:00 (UTC)',
  );
});
