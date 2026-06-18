import { getPool } from './pool.js';

// ─────────────────────────────────────────────────────────────────────────────
// Per-project execution schema (M7 Phase 2, DESIGN-isolation-tiers.md / D53).
//
// A `dedicated`-tier project keeps its EXECUTION data (jobs/batches/chunks/logs/
// events/errors) in its own Postgres schema `proj_<id>` inside the SAME control
// database. Control-plane tables (projects, job_definitions, outbox, audit,
// worker_nodes) stay in `public`. A dedicated worker — and the enqueue path —
// run with `search_path = proj_<id>, public`, so unqualified table names resolve
// to the project schema and control tables fall through to `public`. No query in
// the worker/reporter is schema-qualified, so search_path alone routes them.
//
// Keeping it one database (separate SCHEMA, not separate DB) preserves the
// transactional outbox: the jobs row (proj schema) and the outbox row (public)
// still commit in ONE transaction.
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic, injection-safe schema name for a project. `proj_<hex>`. */
export function schemaForProject(projectId: string): string {
  const hex = projectId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error(`invalid project id for schema name: ${projectId}`);
  }
  return `proj_${hex}`;
}

const SCHEMA_NAME_RE = /^proj_[0-9a-f]{32}$/;

/** Assert a schema name is one we generated — guards every search_path/DDL use. */
export function assertSchemaName(schema: string): void {
  if (!SCHEMA_NAME_RE.test(schema)) {
    throw new Error(`refusing to use unrecognized schema name: ${schema}`);
  }
}

// Execution tables, created INSIDE the project schema (search_path is set to it
// for the DDL). Intra-schema FKs are unqualified; cross-schema FKs to the
// control plane are explicitly `public.`-qualified. Mirrors the relevant parts
// of 0001_init.sql + the 0002 idempotency index.
const EXECUTION_DDL = `
CREATE TABLE IF NOT EXISTS jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id   UUID REFERENCES public.job_definitions(id) ON DELETE SET NULL,
  project_id      UUID NOT NULL REFERENCES public.projects(id),
  entity          TEXT NOT NULL,
  type            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','completed','failed','cancelled','cancelling','retrying')),
  idempotency_key TEXT,
  parameters_jsonb  JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_jsonb      JSONB NOT NULL DEFAULT '{}'::jsonb,
  destination_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  rule_set_id     UUID,
  priority        INTEGER NOT NULL DEFAULT 5,
  attempt         INTEGER NOT NULL DEFAULT 1,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  queued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  worker_id       TEXT,
  error_summary   TEXT
);

CREATE TABLE IF NOT EXISTS batches (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  total_rows       BIGINT,
  chunk_size       INTEGER NOT NULL,
  chunk_count      INTEGER NOT NULL,
  chunks_remaining INTEGER NOT NULL,
  error_count      INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'running',
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS batch_chunks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  chunk_index     INTEGER NOT NULL,
  row_start       BIGINT NOT NULL,
  row_end         BIGINT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempt         INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  processed_count INTEGER NOT NULL DEFAULT 0,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  UNIQUE (batch_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS job_logs (
  id          BIGSERIAL PRIMARY KEY,
  job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  batch_id    UUID,
  chunk_index INTEGER,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  level       TEXT NOT NULL CHECK (level IN ('trace','debug','info','warn','error')),
  message     TEXT NOT NULL,
  data_jsonb  JSONB
);

CREATE TABLE IF NOT EXISTS job_events (
  id          BIGSERIAL PRIMARY KEY,
  job_id      UUID REFERENCES jobs(id) ON DELETE CASCADE,
  project_id  UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  type        TEXT NOT NULL,
  actor       TEXT,
  message     TEXT,
  data_jsonb  JSONB
);

CREATE TABLE IF NOT EXISTS job_errors (
  id         BIGSERIAL PRIMARY KEY,
  job_id     UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  batch_id   UUID,
  row_number BIGINT,
  field      TEXT,
  rule       TEXT,
  message    TEXT NOT NULL,
  raw_jsonb  JSONB
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_project_queued ON jobs(status, project_id, queued_at);
CREATE INDEX IF NOT EXISTS idx_job_logs_job_ts            ON job_logs(job_id, ts);
CREATE INDEX IF NOT EXISTS idx_batch_chunks_batch         ON batch_chunks(batch_id);
CREATE INDEX IF NOT EXISTS idx_job_events_ts              ON job_events(ts DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_idempotency_key ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
`;

/**
 * Provision (idempotently) the per-project execution schema and record its name
 * on the project row. Safe to call repeatedly. Returns the schema name.
 */
export async function provisionProjectSchema(projectId: string): Promise<string> {
  const schema = schemaForProject(projectId);
  assertSchemaName(schema);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    // Create the execution tables INSIDE the schema; cross-schema FKs stay
    // public.-qualified, intra-schema ones resolve to this schema.
    await client.query(`SET LOCAL search_path TO ${schema}, public`);
    await client.query(EXECUTION_DDL);
    await client.query(`UPDATE public.projects SET db_schema=$1, updated_at=now() WHERE id=$2`, [schema, projectId]);
    await client.query('COMMIT');
    return schema;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Tear down a project's execution schema (used on demote/delete). */
export async function dropProjectSchema(projectId: string): Promise<void> {
  const schema = schemaForProject(projectId);
  assertSchemaName(schema);
  await getPool().query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await getPool().query(`UPDATE projects SET db_schema=NULL, updated_at=now() WHERE id=$1`, [projectId]);
}
