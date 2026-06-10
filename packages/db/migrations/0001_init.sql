-- ─────────────────────────────────────────────────────────────────────────────
-- Conductor control-plane schema (PostgreSQL).
-- This is Conductor's OWN database — distinct from any target project DB.
-- Mirrors spec §8. Tables for later milestones are created now to avoid churn.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()

-- ── Auth: users / roles / api keys ──────────────────────────────────────────
-- Role model is fixed (Admin/Operator/Viewer) per spec §17; stored as text.
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')),
  password_hash TEXT,                       -- null when authenticated via OIDC
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,         -- store only the hash, never the key
  role        TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')),
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ
);

-- ── Projects (data sources) ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  description       TEXT,
  environment       TEXT NOT NULL DEFAULT 'test' CHECK (environment IN ('prod','test')),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  provider          TEXT NOT NULL CHECK (provider IN ('postgres','sqlserver','mysql')),
  host              TEXT NOT NULL,
  port              INTEGER NOT NULL,
  database          TEXT NOT NULL,
  schema            TEXT,
  username          TEXT NOT NULL,
  secret_ciphertext JSONB NOT NULL,         -- envelope-encrypted blob (never plaintext)
  secret_key_id     TEXT NOT NULL,          -- which master key wrapped the DEK
  ssl_mode          TEXT NOT NULL DEFAULT 'prefer',
  options_jsonb     JSONB NOT NULL DEFAULT '{}'::jsonb,
  pool_max          INTEGER NOT NULL DEFAULT 5,
  query_timeout_s   INTEGER NOT NULL DEFAULT 30,
  max_rows          BIGINT NOT NULL DEFAULT 5000000,
  concurrency_limit INTEGER NOT NULL DEFAULT 4,
  allowlist_hosts   TEXT[] NOT NULL DEFAULT '{}',  -- admin-approved hosts/CIDRs (SSRF)
  created_by        UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ                    -- soft delete
);

CREATE TABLE IF NOT EXISTS project_entities (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  target_table TEXT NOT NULL,
  primary_key  TEXT NOT NULL,
  rule_set_id  UUID,
  mapping_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS rule_sets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity      TEXT NOT NULL,
  version     INTEGER NOT NULL,
  rules_jsonb JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','draft','archived')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  UUID REFERENCES users(id),
  UNIQUE (project_id, entity, version)
);

-- ── Scheduling ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_definitions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity          TEXT NOT NULL,
  type            TEXT NOT NULL,
  name            TEXT NOT NULL,
  schedule_kind   TEXT NOT NULL CHECK (schedule_kind IN ('cron','one_time','recurring')),
  cron            TEXT,
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  source_jsonb    JSONB NOT NULL DEFAULT '{}'::jsonb,
  destination_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  options_jsonb   JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  next_run_at     TIMESTAMPTZ,
  last_run_at     TIMESTAMPTZ,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Jobs & execution ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id   UUID REFERENCES job_definitions(id) ON DELETE SET NULL,
  project_id      UUID NOT NULL REFERENCES projects(id),
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

-- ── Logs / events / errors (queryable + streamable) ──────────────────────────
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
  project_id  UUID REFERENCES projects(id) ON DELETE SET NULL,
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

-- ── Workers ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS worker_nodes (
  id                TEXT PRIMARY KEY,        -- worker self-assigned id
  name              TEXT NOT NULL,
  pool              TEXT NOT NULL CHECK (pool IN ('core','edge')),
  host              TEXT,
  version           TEXT,
  status            TEXT NOT NULL DEFAULT 'online',
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  in_flight         INTEGER NOT NULL DEFAULT 0,
  capabilities_jsonb JSONB NOT NULL DEFAULT '[]'::jsonb
);

-- ── Transactional outbox (reliable publish — spec §5.2) ──────────────────────
CREATE TABLE IF NOT EXISTS outbox (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_id UUID NOT NULL,
  routing_key  TEXT NOT NULL,
  payload_jsonb JSONB NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ,
  attempts     INTEGER NOT NULL DEFAULT 0
);

-- ── Audit log (every mutation + every project-connection use) ────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor      TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  project_id UUID,
  job_id     UUID,
  data_jsonb JSONB
);

-- ── Indexes (spec §8) ─────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_jobs_status_project_queued ON jobs(status, project_id, queued_at);
CREATE INDEX IF NOT EXISTS idx_job_logs_job_ts            ON job_logs(job_id, ts);
CREATE INDEX IF NOT EXISTS idx_batch_chunks_batch         ON batch_chunks(batch_id);
CREATE INDEX IF NOT EXISTS idx_job_events_ts              ON job_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_status_created      ON outbox(status, created_at);
CREATE INDEX IF NOT EXISTS idx_projects_status            ON projects(status) WHERE deleted_at IS NULL;
