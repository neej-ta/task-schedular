-- Folded-in demo TARGET database.
--
-- Previously this lived in a separate `demo-target` Postgres container. To keep
-- the stack at <=5 containers it now runs as a second database on the main
-- control-plane Postgres instance: a distinct `demo` database owned by a
-- distinct `demo` role, fully isolated from the control plane (`conductor` DB).
--
-- This script runs once, on first cluster init, as the superuser (`conductor`)
-- against the default `conductor` database (docker-entrypoint-initdb.d).

CREATE USER demo WITH PASSWORD 'demo_dev_pw';
CREATE DATABASE demo OWNER demo;

\connect demo

-- Demo TARGET schema (the bulk_import demo promotes validated rows here).
-- UNIQUE constraints on email + customer_code back the idempotent upsert and
-- the parallel-uniqueness guarantee (spec §5.5, §13).
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

-- The demo project connects as the `demo` role, so it must own the objects it
-- reads/writes during bulk import/update/delete.
ALTER TABLE customers OWNER TO demo;
ALTER SEQUENCE customers_id_seq OWNER TO demo;
