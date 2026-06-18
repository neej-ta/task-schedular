-- Per-project isolation tiers (M7, DESIGN-isolation-tiers.md / DECISIONS D52–D55).
--
-- `isolation_mode` selects the tier:
--   'shared'    — today's behavior: shared scheduler + worker pool, isolated
--                 logically by project_id + the Redis per-project semaphore (D45).
--   'dedicated' — opt-in: the project's jobs route to per-project queues
--                 (conductor.q.<type>.p.<id>) drained by a dedicated worker
--                 container, and (Phase 2) its execution data lives in `db_schema`.
--
-- `db_schema` and `container_state` are populated by later phases (per-project
-- schema provisioning + the Docker-Engine-API provisioner); added now with inert
-- defaults so the column shape is stable.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS isolation_mode TEXT NOT NULL DEFAULT 'shared'
    CHECK (isolation_mode IN ('shared', 'dedicated')),
  ADD COLUMN IF NOT EXISTS db_schema TEXT,
  ADD COLUMN IF NOT EXISTS container_state TEXT NOT NULL DEFAULT 'none'
    CHECK (container_state IN ('none', 'provisioning', 'running', 'stopping', 'stopped', 'error'));
