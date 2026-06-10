# Architecture

Conductor is a multi-project background job platform. It offloads heavy data
work (bulk import/insert/update/delete, file I/O, XML, REST) off product
frontends and runs it asynchronously across a worker pool, with full real-time
operational visibility.

This document tracks the **as-built** architecture. See the master spec for the
complete target design; sections marked _(planned)_ land in later milestones.

## Services (all Node/TS — see DECISIONS D1)

| Service | Role | Status |
|---------|------|--------|
| `gateway-api` | REST API, auth + RBAC, secret encryption, projects registry, **realtime SSE** (logs/progress/activity). | **M1–M4** |
| `scheduler` | Clustered (advisory-lock leader); fires schedules and **enqueues only** (never executes). | **M2** |
| `outbox-relay` | Publishes outbox rows to RabbitMQ with publisher confirms. Hosted inside the scheduler; runs on every instance. | **M2** |
| `worker-core` | Handler registry on the shared runtime: `bulk_import`/`bulk_insert`/`xml_integration` (shared pipeline), `bulk_update`, `bulk_delete` + rule engine + bulk DB ops. | **M3, M5** |
| `worker-edge` | Integration handlers: `file_inbound`/`file_outbound`, `rest_pull`/`rest_push`. | **M5** |
| `dashboard` | React operations UI. | **M1** (Projects only) |

## Packages

- `@conductor/contracts` — shared zod schemas: the **job envelope** (§9) and the
  **rule schema** (§10), plus cross-cutting enums (roles, providers, queue keys).
  The single source of truth both API and workers import — never hand-duplicated.
- `@conductor/db` — control-plane Postgres pool, transaction helper, and the
  forward-only migration runner + the full §8 schema.
- `@conductor/core` — `enqueueJob` (job + outbox in one tx); shared by gateway + scheduler.
- `@conductor/messaging` — RabbitMQ connection, topology, publisher-confirm publish.
- `@conductor/security` — envelope crypto (AES-256-GCM) + SSRF guard; shared by gateway + worker.
- `@conductor/storage` — S3/MinIO client (read sources, write exports).
- `@conductor/realtime` — Redis pub/sub channels, progress-counter hashes, cancel flags (live SSE plane).
- `@conductor/rule-engine` — single TS evaluator, driven by `@conductor/rule-conformance` vectors.
- `@conductor/targetdb` — pooled, SSRF-pinned target-DB access (connect/query/introspect/coerce); shared by both workers.
- `@conductor/worker-runtime` — generic Runner (consume/ack/retry/heartbeat/drain + per-project concurrency gate + dead-worker reclaim + metrics) + reporter + context.
- `@conductor/telemetry` — Prometheus metrics registry + `/metrics` server + fail-soft OTel tracing hook.

## Observability (M6)

- **Metrics**: Prometheus scrapes gateway `:8080/metrics` + workers `:9101/:9102`; Grafana (`:3001`, provisioned datasource + "Conductor" dashboard) visualizes jobs by status/type, rows/s, p95 duration, queue depth, worker in-flight.
- **Tracing**: OTel is a fail-soft integration point (set `OTEL_EXPORTER_OTLP_ENDPOINT` + add the OTel packages + a Collector/Tempo) — omitted from the default build to keep it CVE-free.
- **Concurrency**: per-project Redis semaphore caps concurrent jobs/project (over-limit → deferred); dead workers' jobs are reclaimed on redelivery.

## Data planes (kept strictly separate)

- **Control-plane DB** (`postgres`): Conductor's own state — projects, schedules,
  jobs, batches, chunks, logs, events, errors, outbox, audit. Defined in
  `packages/db/migrations/0001_init.sql`.
- **Target project DBs** (external; `demo-target` locally): the databases jobs
  read/write. Connections are registered as **Projects**, with credentials
  envelope-encrypted at rest and used only in-memory inside a worker.

## Request flow (M1)

```
Operator → dashboard → gateway-api → control-plane DB
                          │
                          ├─ POST /projects            (Admin)  → encrypt secret → store
                          └─ POST /projects/:id/test-connection (Operator+)
                                   → SSRF guard (resolve + validate IP, allow-list)
                                   → decrypt secret in-memory → open target conn → SELECT 1
                                   → audit (no secret, no plaintext)
```

## Target flow (later milestones)

```
gateway-api  ──(job + outbox row, 1 tx)──► control-plane DB
outbox-relay ──(publisher confirms)──────► RabbitMQ (capability queues + DLQ)
worker-core / worker-edge  ──consume──► run handler ──► staging → promote → target DB
                                          │
                                          └─ progress (Redis) + logs/events (DB) → SSE/WS → dashboard
```

## Key invariants (spec §5 / §13 — non-negotiable)

- Scheduler **enqueues only**; never executes.
- Reliable publish via **transactional outbox** (job row + outbox row in one tx).
- **At-least-once delivery + idempotent handlers**; deterministic chunk ids; upserts.
- **Bulk = staging + DB-enforced correctness** (uniqueness/FKs via DB constraints,
  never coordinated in app code across parallel chunks).
- Rules are **declarative data evaluated in-process, per row**.
- **Lease heartbeats** for long jobs; **ack only after durable**; **graceful shutdown**.
- Secrets encrypted at rest, never logged, masked in UI. **SSRF** deny-by-default.
- Everything correlates by `jobId / batchId / chunkIndex / projectId / traceId`.

## Security posture (M1)

- Envelope encryption (AES-256-GCM) for project secrets; pino log redaction; masked API responses.
- Deny-by-default SSRF egress guard with admin allow-list and resolved-IP validation.
- Server-side RBAC (admin > operator > viewer) on every mutation; audit log for all mutations + connection use.
- Parameterized SQL only; per-project query timeout + row caps stored on the project.
