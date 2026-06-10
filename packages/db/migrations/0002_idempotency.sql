-- Idempotent enqueue (spec §5.4, §13). A UNIQUE index on the idempotency key
-- guarantees a given logical job is enqueued at most once — even if a clustered
-- scheduler briefly has two leaders, or a request is retried. Partial: jobs
-- without a key (rare) are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_idempotency_key
  ON jobs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
