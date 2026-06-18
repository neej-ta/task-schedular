# Conductor

> A multi-project **background task scheduling & execution platform**. Offload
> heavy data work — bulk import/insert/update/delete, file I/O, XML, and REST
> integrations — off your product frontends, run it asynchronously across a
> worker pool, and watch every job's parameters, logs, progress, and errors in
> real time.

Conductor is an **all-Node / TypeScript** monorepo (see
[`docs/DECISIONS.md`](docs/DECISIONS.md) D1). The entire local stack comes up
with a single `docker compose up --build`, pre-seeded with a working demo across
all nine job types.

---

## Table of contents

- [Features](#features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Quick start (Docker)](#quick-start-docker)
- [Service URLs & credentials](#service-urls--credentials)
- [Configuration](#configuration)
- [Local development (without Docker)](#local-development-without-docker)
- [Database migrations & seeding](#database-migrations--seeding)
- [Job types](#job-types)
- [Testing & type-checking](#testing--type-checking)
- [Repository layout](#repository-layout)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)
- [License](#license)

---

## Features

- **Reliable scheduling** — clustered scheduler with advisory-lock leader
  election (only one instance fires), a recurrence builder (Daily / Weekly /
  Monthly / Hourly / Every-N-minutes / One-time / raw cron) with timezone
  support, and a live next-run preview.
- **Exactly-once enqueue** — transactional outbox (job + outbox row in one DB
  transaction), an outbox relay with publisher confirms and `SKIP LOCKED`, and
  deterministic idempotency keys backed by a `UNIQUE` index, so jobs never
  double-fire.
- **At-least-once execution** — manual ack-after-durable, idempotent job claim,
  retry with exponential backoff via a delayed exchange, and a dead-letter queue
  (DLQ) on exhaustion with replay.
- **Nine job handlers** — `bulk_import`, `bulk_insert`, `bulk_update`,
  `bulk_delete`, `xml_integration`, `file_inbound`, `file_outbound`, `rest_pull`,
  `rest_push` (see [Job types](#job-types)).
- **Real-time visibility** — Server-Sent Events for per-job log/progress/state
  streams and a global activity feed; a React dashboard with a live progress bar,
  chunk heat-grid, follow/filter/search logs, an errors table with CSV export,
  and a timeline.
- **Security-first** — envelope encryption for secrets (AES-256-GCM, masked in
  the API and redacted in logs), JWT + API-key auth with server-side RBAC, an
  audit log, and a deny-by-default SSRF egress guard (resolved-IP validation +
  admin allow-list) on both target-DB and outbound-REST traffic.
- **Built for throughput** — per-project concurrency limits (atomic Redis/Valkey
  semaphore), multi-row staging inserts, and DB-enforced correctness (uniqueness
  via a staging `UNIQUE` index, idempotent upsert on promote). Reference load
  test: **1,000,000 rows imported in ~46s while gateway-API p95 stays single-digit ms.**

> Milestone-by-milestone detail (M1–M6) lives in
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and
> [`docs/DECISIONS.md`](docs/DECISIONS.md).

---

## Architecture

The local development stack is **consolidated to five containers**, all
permissively licensed (PostgreSQL / MPL-2.0 / BSD / Apache-2.0 — no AGPL or
source-available components):

| Container   | Image                       | Role |
|-------------|-----------------------------|------|
| `postgres`  | `postgres:16-alpine`        | Control-plane DB **+ a folded-in `demo` target database** (separate role/db) |
| `rabbitmq`  | built from `deploy/rabbitmq` | Message broker with the delayed-message-exchange plugin |
| `valkey`    | `valkey/valkey:8-alpine`    | Cache, locks, and progress counters (BSD Redis replacement) |
| `seaweedfs` | `chrislusf/seaweedfs`       | S3-compatible object storage (Apache-2.0 MinIO replacement) |
| `app`       | built from `deploy/app`     | All backend services **+ dashboard + a folded-in mock-REST** as supervised processes |

The `app` container runs four Node services plus a mock-REST stand-in under a
single supervisor (`deploy/app/supervisor.mjs`) and serves the pre-built
dashboard SPA same-origin from the gateway:

```
app container
├── gateway-api   (:8080)  REST API + auth/RBAC + secret crypto + dashboard SPA
├── scheduler             clustered scheduler + outbox relay
├── worker-core   (:9101)  rule engine + bulk_* + xml_integration handlers
├── worker-edge   (:9102)  file_* + rest_* integration handlers
└── mock-rest  (127.0.0.1:4000)  in-container stand-in for an external REST API
```

> **Note:** `docker-compose.yml` is the single source of truth for the running
> stack. Some files under `docs/` and `deploy/grafana` / `deploy/prometheus`
> describe an older topology (separate per-service containers, MinIO, Grafana,
> a standalone demo-target DB) that is **not** part of the current 5-container
> dev stack.

---

## Prerequisites

| Tool             | Version | Notes |
|------------------|---------|-------|
| Docker Engine    | 24+     | With the Compose v2 plugin (`docker compose`, not `docker-compose`) |
| Node.js          | ≥ 20    | Only needed for the no-Docker workflow; Docker images pin Node 22 |
| npm              | ≥ 10    | Ships with Node 20+ |

That's it for the Docker path — everything else is provided by the images.

---

## Quick start (Docker)

```bash
git clone <your-fork-url> task-schedular
cd task-schedular

# Optional — Compose already bakes in working dev defaults.
cp .env.example .env

docker compose up --build
```

On first boot the `app` container automatically:

1. **Migrates** the control-plane schema (`AUTO_MIGRATE=true`).
2. **Seeds** the admin/operator/viewer users and the demo project + definitions
   for all nine job types (`SEED_ON_BOOT=true`).
3. **Builds and serves** the dashboard SPA from the gateway on `:8080`.

Wait for the `app` healthcheck to report healthy (`GET /healthz`), then open the
dashboard.

### Try the demo

1. Open **http://localhost:8080** and sign in as `admin@conductor.local` / `admin123`.
2. You'll land on the seeded **Demo (demo-target)** project — click **Test
   connection** to open a real connection to the demo Postgres database and see
   the round-trip latency.
3. Go to **Schedules**. Each of the nine handler types has a *Demo …*
   definition — hit **Run now** and watch it live in **Jobs** (logs, progress
   bar, chunk grid, errors, timeline).
4. Check cluster health and DLQ replay on **Workers**, and charts on **Metrics**.

To stop and wipe the stack (including volumes):

```bash
docker compose down -v
```

---

## Service URLs & credentials

| URL                              | What |
|----------------------------------|------|
| http://localhost:8080            | Dashboard **and** Gateway API (same origin) |
| http://localhost:8080/healthz    | Liveness probe |
| http://localhost:8080/readyz     | Readiness probe |
| http://localhost:15672           | RabbitMQ management UI |
| http://localhost:9333            | SeaweedFS master UI |
| http://localhost:9101/metrics    | worker-core Prometheus metrics |
| http://localhost:9102/metrics    | worker-edge Prometheus metrics |

**Seeded users** (dev only — defined in `services/gateway-api/src/seed.ts`):

| Email                       | Password      | Role     |
|-----------------------------|---------------|----------|
| `admin@conductor.local`     | `admin123`    | admin    |
| `operator@conductor.local`  | `operator123` | operator |
| `viewer@conductor.local`    | `viewer123`   | viewer   |

**Infra credentials** (dev only): Postgres / RabbitMQ / SeaweedFS all use
`conductor` / `conductor_dev_pw`. The demo target DB uses `demo` / `demo_dev_pw`.

> ⚠️ **Every credential and key above is for local development only.** Never use
> these values — or commit a real `.env` — in production.

---

## Configuration

Configuration is 12-factor (environment variables). Compose injects working dev
defaults, so an `.env` file is **optional** for local use. Copy
[`.env.example`](.env.example) to `.env` to override anything. Key variables:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Control-plane Postgres connection string |
| `RABBITMQ_URL` | AMQP broker URL |
| `REDIS_URL` | Valkey/Redis URL (cache, locks, progress) |
| `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET` | Object storage (SeaweedFS) |
| `CONDUCTOR_MASTER_KEY` | 32-byte base64 KEK for secret envelope encryption |
| `CONDUCTOR_MASTER_KEY_ID` | Key id for KEK rotation |
| `JWT_SECRET` / `JWT_ISSUER` / `JWT_EXPIRES_IN` | Auth token signing |
| `SSRF_ALLOWLIST` | Comma-separated hostnames/CIDRs allowed past the deny-by-default egress guard |
| `GATEWAY_PORT` / `GATEWAY_HOST` / `CORS_ORIGIN` | Gateway binding & CORS |
| `AUTO_MIGRATE` / `SEED_ON_BOOT` / `SERVE_DASHBOARD` | App-container boot behavior |
| `SCHEDULER_TICK_MS` / `RELAY_TICK_MS` | Scheduler & outbox-relay cadence |
| `LOG_LEVEL` | Pino log level |

Generate a real master key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

---

## Local development (without Docker)

You'll need a local Postgres, RabbitMQ, Valkey/Redis, and an S3-compatible store
reachable from the URLs in your `.env`. Then:

```bash
npm install                       # installs the whole workspace graph

# Point DATABASE_URL at your local Postgres and set a 32-byte base64
# CONDUCTOR_MASTER_KEY (see above), then:
npm run migrate                   # apply control-plane migrations
npm run seed                      # seed users + demo project/definitions

npm run gateway                   # gateway-api (+ dashboard if SERVE_DASHBOARD) on :8080
npm run dashboard                 # Vite dev server on :5173
```

The Vite dev server (`:5173`) talks to the gateway cross-origin via
`VITE_API_BASE`; the production bundle is built with an empty base and served
same-origin by the gateway.

The scheduler and workers are started for you inside the `app` container in
Docker. To run them individually outside Docker, use `tsx` directly, e.g.:

```bash
npx tsx services/scheduler/src/main.ts
npx tsx services/worker-core/src/main.ts
npx tsx services/worker-edge/src/main.ts
```

---

## Database migrations & seeding

Migrations are forward-only and run by a small TypeScript runner.

```bash
npm run migrate                   # = npm run migrate -w @conductor/db
npm run seed                      # = npm run seed -w @conductor/gateway-api
```

In Docker these run automatically on boot via `AUTO_MIGRATE` / `SEED_ON_BOOT`.
Both are idempotent — re-running creates no duplicates.

---

## Job types

The demo seeds one definition per handler; **Run now** any of them from the
**Schedules** page.

| Type | Worker | What it does |
|------|--------|--------------|
| `bulk_import`     | core | Source (CSV/JSON/XML/inline) → map → validate → transform → staging → idempotent promote |
| `bulk_insert`     | core | Batch insert into a target DB |
| `bulk_update`     | core | Batch update with optimistic concurrency |
| `bulk_delete`     | core | Dry-run + soft-delete by default; hard-delete past a threshold |
| `xml_integration` | core | XML ingest/serialize integration |
| `file_inbound`    | edge | Fetch a file → stage → enqueue an import |
| `file_outbound`   | edge | Query → serialize → write to object storage |
| `rest_pull`       | edge | Paginate a REST API → enqueue inserts |
| `rest_push`       | edge | Batch POST rows to a REST API with backoff |

### Target databases

Every DB job type runs against a **PostgreSQL, SQL Server, or MySQL** target —
chosen per project by `projects.provider` — through the dialect-aware
`@conductor/targetdb` adapter (placeholders, identifier quoting, idempotent
promote, staging, and error classification are all dialect-specific behind one
interface). Because target backends are reached over a direct DB connection (any
of the three) or plain HTTP (`rest_pull`/`rest_push`), the target project's own
backend language — Node, .NET, anything — is irrelevant.

Optional SQL Server / MySQL containers (compose `mssql` / `mysql` profiles) back
end-to-end adapter tests:

```bash
docker compose --profile mssql up -d sqlserver     # wait until healthy
npm run itest:mssql                                # 6 cases against real SQL Server

docker compose --profile mysql up -d mysql         # wait until healthy
npm run itest:mysql                                # 6 cases against real MySQL
```

---

## Testing & type-checking

```bash
npm test          # workspace unit tests (--workspaces --if-present)
npm run typecheck # type-checks every workspace
```

`npm run typecheck` runs each workspace's check (`--workspaces --if-present`);
the target-DB SQL Server integration test (`npm run itest:mssql`) is separate
and needs the `mssql`-profile container up.

---

## Repository layout

```
.
├── packages/
│   ├── contracts        Shared Zod schemas (job envelope, rule schema) + types
│   ├── core             Shared core utilities
│   ├── db               Control-plane schema, migration runner, pg pool
│   ├── messaging        RabbitMQ topology + publish/consume helpers
│   ├── realtime         Redis/Valkey pub-sub, progress counters, cancel flags
│   ├── rule-engine      Single TS rule evaluator (required/regex/range/… + transforms)
│   ├── rule-conformance Shared conformance vectors for the rule engine
│   ├── security         Envelope encryption (AES-256-GCM), masking, SSRF guard
│   ├── storage          S3/SeaweedFS object-storage client
│   ├── targetdb         SSRF-pinned target-DB connector
│   ├── telemetry        Metrics / OpenTelemetry helpers
│   └── worker-runtime   Generic Runner shared by both workers
├── services/
│   ├── gateway-api      Fastify REST API, auth/RBAC, secret crypto, projects
│   ├── scheduler        Clustered scheduler + outbox relay
│   ├── worker-core      Rule engine + bulk_* + xml_integration handlers
│   └── worker-edge      file_* + rest_* integration handlers
├── dashboard/           React + Vite operations UI
├── deploy/              Dockerfiles, supervisor, seed SQL, broker plugin, S3 config
├── docs/                ARCHITECTURE.md · DECISIONS.md · RUNBOOK.md
├── scripts/             E2E sweep + UI smoke/screenshot helpers
├── docker-compose.yml   Local 5-container dev stack (source of truth)
├── .env.example         Documented env template
└── package.json         npm-workspaces root
```

---

## Troubleshooting

- **`app` won't go healthy / connection refused.** It depends on `postgres`,
  `rabbitmq`, and `valkey` being healthy first. Give it the
  `start_period` (~40s) and check `docker compose logs app`.
- **Port already in use.** The stack binds `5432`, `5672`, `15672`, `6379`,
  `8080`, `8333`, `9333`, `9101`, `9102`. Free the conflicting port or remap it
  in `docker-compose.yml`.
- **Stale state / want a clean slate.** `docker compose down -v` removes the
  `pgdata` and `seaweeddata` volumes so the next `up` re-migrates and re-seeds.
- **SSRF guard blocks a connection.** Target-DB and outbound-REST hosts must be
  on `SSRF_ALLOWLIST` (the demo allow-lists `postgres` and `127.0.0.1/32`).
- **Root `tsc -b` fails.** Use `npm run typecheck --workspaces --if-present`.

See [`docs/RUNBOOK.md`](docs/RUNBOOK.md) for operational procedures.

---

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system design and data flow.
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — architecture decision records.
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — operations & incident runbook.

---

## License

Conductor depends only on permissively licensed components (PostgreSQL / MPL-2.0
/ BSD / Apache-2.0). Add a `LICENSE` file declaring the license for this
repository before publishing.
