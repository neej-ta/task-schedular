import parser from 'cron-parser';
import { query } from '@conductor/db';
import { enqueueJob } from '@conductor/core';
import type { JobType } from '@conductor/contracts';

// ─────────────────────────────────────────────────────────────────────────────
// Schedule evaluation (spec §5.1). Runs on the LEADER only. Fires due
// JobDefinitions by ENQUEUEING (job + outbox in one tx via @conductor/core);
// never executes work. Each fire carries a deterministic idempotency key so a
// brief double-leader can never double-fire the same occurrence.
// ─────────────────────────────────────────────────────────────────────────────

interface JobDefRow {
  id: string;
  project_id: string;
  entity: string;
  type: JobType;
  schedule_kind: 'cron' | 'one_time' | 'recurring';
  cron: string | null;
  timezone: string;
  source_jsonb: Record<string, unknown>;
  destination_jsonb: Record<string, unknown>;
  options_jsonb: Record<string, unknown>;
  next_run_at: string | null;
}

function nextOccurrence(cron: string, timezone: string, after: Date): Date {
  const interval = parser.parseExpression(cron, { tz: timezone, currentDate: after });
  return interval.next().toDate();
}

export async function evaluateSchedules(log: (msg: string) => void): Promise<number> {
  const now = new Date();

  const { rows } = await query<JobDefRow>(
    `SELECT id, project_id, entity, type, schedule_kind, cron, timezone,
            source_jsonb, destination_jsonb, options_jsonb, next_run_at
       FROM job_definitions
      WHERE enabled = true
        AND schedule_kind IN ('cron','one_time','recurring')`,
  );

  let fired = 0;
  for (const def of rows) {
    // Initialize an unset next_run_at from the cron without firing this tick.
    if (def.next_run_at === null) {
      if (def.cron) {
        const next = nextOccurrence(def.cron, def.timezone, now);
        await query('UPDATE job_definitions SET next_run_at=$2 WHERE id=$1', [def.id, next]);
      }
      continue;
    }

    const due = new Date(def.next_run_at) <= now;
    if (!due) continue;

    const fireTime = new Date(def.next_run_at);
    const idempotencyKey = `sched:${def.id}:${fireTime.toISOString()}`;

    const res = await enqueueJob({
      projectId: def.project_id,
      entity: def.entity,
      type: def.type,
      idempotencyKey,
      definitionId: def.id,
      source: def.source_jsonb,
      destination: def.destination_jsonb,
      options: def.options_jsonb,
    });
    if (res.enqueued) {
      fired++;
      log(`[scheduler] fired definition ${def.id} (${def.type}) → job ${res.jobId}`);
    }

    // Advance the schedule.
    let nextRun: Date | null = null;
    if (def.schedule_kind === 'one_time') {
      await query(
        'UPDATE job_definitions SET enabled=false, last_run_at=now(), next_run_at=NULL WHERE id=$1',
        [def.id],
      );
    } else if (def.cron) {
      nextRun = nextOccurrence(def.cron, def.timezone, now);
      await query('UPDATE job_definitions SET last_run_at=now(), next_run_at=$2 WHERE id=$1', [
        def.id,
        nextRun,
      ]);
    }
  }
  return fired;
}
