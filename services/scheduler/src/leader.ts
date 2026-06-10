
import pg from 'pg';
import { config } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Leader election via a PostgreSQL session-level advisory lock (spec §5.1).
//
// The lock is held by exactly one session cluster-wide. The holder is the
// scheduler "leader" and is the only instance that fires schedules. If the
// leader dies, its session closes, Postgres releases the lock automatically,
// and another instance acquires it on its next tick — no split brain, no extra
// infrastructure. (Idempotent enqueue is the defense-in-depth backstop.)
// ─────────────────────────────────────────────────────────────────────────────

export class LeaderElector {
  private client: pg.Client | null = null;
  private holding = false;

  constructor(private readonly log: (msg: string) => void) {}

  isLeader(): boolean {
    return this.holding;
  }

  /** Try to (re)acquire leadership. Safe to call every tick. */
  async tick(): Promise<void> {
    try {
      if (!this.client) {
        this.client = new pg.Client({ connectionString: process.env.DATABASE_URL });
        this.client.on('error', () => this.reset());
        await this.client.connect();
      }
      if (this.holding) return; // session-level lock is reentrant — don't re-lock

      const { rows } = await this.client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [config.leaderLockKey.toString()],
      );
      if (rows[0]?.locked) {
        this.holding = true;
        this.log(`[leader] acquired leadership (${config.instanceId})`);
      }
    } catch (err) {
      this.log(`[leader] error: ${(err as Error).message}`);
      this.reset();
    }
  }

  private reset(): void {
    this.holding = false;
    if (this.client) {
      this.client.end().catch(() => {});
      this.client = null;
    }
  }

  async release(): Promise<void> {
    if (this.client && this.holding) {
      await this.client
        .query('SELECT pg_advisory_unlock($1)', [config.leaderLockKey.toString()])
        .catch(() => {});
    }
    this.reset();
  }
}
