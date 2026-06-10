-- Demo TARGET schema (runs in the demo-target Postgres, NOT the control plane).
-- The bulk_import demo promotes validated rows into this table. UNIQUE
-- constraints on email + customer_code back the idempotent upsert and the
-- parallel-uniqueness guarantee (spec §5.5, §13).
CREATE TABLE IF NOT EXISTS customers (
  id            SERIAL PRIMARY KEY,
  customer_name TEXT,
  email         TEXT UNIQUE,
  age           INTEGER,
  country       TEXT,
  customer_code TEXT UNIQUE,
  join_date     DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(), -- bulk_update touches this
  deleted_at    TIMESTAMPTZ                          -- soft-delete (bulk_delete default)
);
