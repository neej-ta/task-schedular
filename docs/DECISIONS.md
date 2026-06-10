# Decisions

Records defaults chosen where the spec left them open, plus any deviations.
Per spec §23, the **§5** and **§13** invariants are preserved; deviations are
documented here.

## Global

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **All-Node/TypeScript build** (spec-permitted swap point in §6). gateway-api, scheduler, worker-core, worker-edge are all Node/TS. | Requested by the operator. One toolchain, faster local iteration. The rule engine stays **single-language** (a single TS implementation), satisfying the §5.6 "one evaluator per runtime" intent — there is only one runtime. |
| D2 | **`docker-compose.yml` lives at the repo root**, not under `/deploy`. | The spec DoD literally calls for `docker compose up`. `/deploy` is reserved for k8s/Helm (later). |
| D3 | **Services run TypeScript directly via `tsx`** (no precompiled build step) in dev containers. | Fastest iteration; one fewer build stage. A `tsc` compile step can be added for production images later. |
| D4 | **npm workspaces** as the monorepo manager. | Built into the installed npm; no extra tooling (pnpm/turbo) needed for this size. |

## Auth (spec §14/§17 say OIDC/JWT)

| # | Decision | Rationale |
|---|----------|-----------|
| D5 | **Local JWT auth with a built-in user store** (email + bcrypt) for M1, plus **API keys** (sha256-hashed) for service-to-service. | OIDC requires an external IdP that isn't part of the local stack. JWTs are signed/verified with the same library surface OIDC would use, so swapping in an OIDC issuer later is localized to `auth/plugin.ts`. Roles (admin/operator/viewer) and server-side RBAC are real now. |
| D6 | Seeded dev users: `admin@conductor.local/admin123`, `operator@.../operator123`, `viewer@.../viewer123`. | Lets the RBAC paths be exercised immediately. Dev-only. |

## Secrets (spec §5.9, §7, §17)

| # | Decision | Rationale |
|---|----------|-----------|
| D7 | **Envelope encryption, AES-256-GCM.** A random 32-byte **DEK** encrypts each secret; the DEK is wrapped by a 32-byte **master KEK** from `CONDUCTOR_MASTER_KEY` (base64). Stored blob = `{v, keyId, wrappedDek, data}`. | Matches the spec's envelope-encryption requirement. `keyId` enables rotation. In prod the KEK comes from a KMS; locally it's an env var. |
| D8 | Secrets are **decrypted in-memory only**, never logged (pino redaction in `server.ts`), never returned (API masks to `••••••••`). | Spec §17. |

## SSRF (spec §7, §17)

| # | Decision | Rationale |
|---|----------|-----------|
| D9 | **Deny-by-default** egress for target-DB connections: loopback/private/link-local/CGNAT/reserved ranges are blocked. The **resolved IP** is validated (not just the hostname) to defeat DNS rebinding. An **admin allow-list** (per-project + global `SSRF_ALLOWLIST`) permits approved hosts/CIDRs. | Spec requirement. The Docker network names (`demo-target`, `postgres`) are allow-listed in dev so the seeded demo — which necessarily resolves to a private IP — works. |

## Database

| # | Decision | Rationale |
|---|----------|-----------|
| D10 | **Forward-only SQL migration runner** (numbered `*.sql`, tracked in `_migrations`), not an ORM migration tool. | Transparent, dependency-light, easy to review. The **full §8 schema** is created in `0001_init.sql` up front to avoid churn across milestones. |
| D11 | gateway-api **auto-migrates and (optionally) seeds on boot** for local dev (`AUTO_MIGRATE`, `SEED_ON_BOOT`). | One-command startup. In prod, migrations run as a separate job (see RUNBOOK). |

## Milestone scope

| # | Decision | Rationale |
|---|----------|-----------|
| D12 | **M1 ships RabbitMQ/Redis/MinIO in compose but they are not yet wired.** The RabbitMQ **delayed-message plugin** is deferred to **M2** (needs a custom image / plugin install). | M1 acceptance only needs projects + test-connection. Standing the infra up now de-risks later milestones. |
| D13 | Dashboard nav lists all spec pages (Jobs/Schedules/Projects/Activity/Workers/Metrics) but only **Projects** is functional in M1. | Matches the milestone plan; later milestones light up each page. |
| D14 | Dashboard is published on **host port 5174** (container 5173). | Vite's default 5173 frequently collides with other local Vite apps; 5174 keeps `docker compose up` deterministic. Gateway CORS allows both 5174 and 5173. |

## M2 — Scheduling & reliable enqueue

| # | Decision | Rationale |
|---|----------|-----------|
| D15 | **Leader election via a PostgreSQL session-level advisory lock** (`pg_try_advisory_lock`), not Quartz/ZooKeeper/etcd. | Spec §5.1 allows "leader election or a DB lease". The advisory lock needs no extra infra, releases automatically when the leader's session dies (clean failover), and we already depend on Postgres. The leader is the only instance that fires schedules. |
| D16 | **Idempotent enqueue is the defense-in-depth backstop** against double-fire: each scheduled occurrence gets a deterministic key `sched:<defId>:<occurrenceISO>`, and a UNIQUE index on `jobs.idempotency_key` makes a second insert a no-op. | Even a brief two-leader window (lock not yet released after a crash) cannot double-fire. |
| D17 | **The outbox relay runs on EVERY scheduler instance**, not just the leader, using `SELECT … FOR UPDATE SKIP LOCKED`. | Publishing is safe to parallelize (rows are locked per-instance) and benefits from HA/throughput; only *scheduling* needs a single leader. |
| D18 | **Relay publishes with publisher confirms** and marks a row `sent` only after the broker acks; failures increment `attempts` and stay `pending` until `MAX_OUTBOX_ATTEMPTS`, then `failed`. | Spec §5.2 — no message is marked sent unless the broker durably accepted it. |
| D19 | **RabbitMQ topology:** `conductor.jobs` (direct) for immediate delivery + `conductor.delayed` (x-delayed-message) for delayed/retry + per-type queues `conductor.q.<type>` each dead-lettering to `conductor.dlx` (fanout) → `conductor.dlq`. The delayed-message plugin is baked into a custom image (`deploy/rabbitmq/Dockerfile`). | Spec §4/§13. Asserted idempotently by every publisher/consumer on startup. |
| D20 | Scheduler is a **separate service** that also hosts the outbox-relay (spec permits hosting the relay in the scheduler). It **never executes work** (§5.1). | Decouples scheduling reliability from execution. |

## M3 — Runner shell + first handler

| # | Decision | Rationale |
|---|----------|-----------|
| D21 | **Shared `@conductor/security` package** holds envelope crypto + the SSRF guard (moved out of gateway). | The worker must decrypt project secrets and SSRF-guard its own target connections; one implementation, no duplication. Master key read from `CONDUCTOR_MASTER_KEY` (must match across gateway + worker). |
| D22 | **Single TS rule engine** (`@conductor/rule-engine`) governed by shared `@conductor/rule-conformance` vectors (24 cases). | Spec §6: one evaluator per runtime; all-Node ⇒ one runtime. CI gates on the conformance suite so any future engine must match. |
| D23 | `unique` and `lookup` are **NOT evaluated in-process** (spec §10 trap). `unique` is enforced by a **DB UNIQUE index on the staging table**; `lookup` resolves against the target DB. The engine surfaces them via `extractStatefulRules()`. | Stateful rules cannot be coordinated across parallel chunks in app code; the DB is the single arbiter. |
| D24 | **`expression`/`computed` use a tiny hand-written safe evaluator** (no `eval`/`Function`): field refs, literals, `! && \|\|`, comparisons, `+ - * /`, parens. | Determinism + no code-injection. Advanced expression features are out of scope; documented limitation. |
| D25 | **Staging lives in the TARGET DB** as an `UNLOGGED` per-job table `conductor_stg_<jobId>` with one UNIQUE index per business-key column; **promote = `INSERT … SELECT … ON CONFLICT DO NOTHING`**. | Same-DB promote is transactional and fast; the bare `ON CONFLICT DO NOTHING` makes redelivery/re-run idempotent against ANY unique/PK conflict (spec §5.5, §13). |
| D26 | **M3 chunks a bulk job IN-PROCESS** (bounded concurrency `CHUNK_CONCURRENCY`), writing `batches`/`batch_chunks` for visibility. Cross-worker chunk-message fan-out is **deferred to M6** (§12). | M3 acceptance (import + idempotency + parallel-uniqueness) is fully met in-process; concurrent chunk writes to staging genuinely race the DB unique index. Fan-out is a scaling concern. |
| D27 | **worker-core M3 supports PostgreSQL targets only**; MySQL/SQL Server target writers land in M5. | The demo target is Postgres; the connection test already covers all three. |
| D28 | **Retries via the delayed exchange** with exponential backoff (`base·2^(attempt-1)`), capped at `jobs.max_attempts`; exhaustion → **DLQ** + job `failed` + event. **Ack only after the unit is durable** (§13). | Verified live: a failing job retried 5× with backoff then dead-lettered. |
| D29 | **M3 progress/visibility is DB-backed** (`batches.chunks_remaining`, `batch_chunks`, `job_logs`, `job_events`, `job_errors`). Redis counters + live SSE/WS streaming arrive in **M4**. | Keeps M3 focused; the data the dashboard needs is already persisted. |
| D30 | Long-lived services **wait for the control-plane schema** on boot (retry) rather than assuming migrations ran. | worker-core raced gateway's on-boot migration once; tolerating a not-yet-migrated DB matches the prod pattern where migrations are a separate job. |

## M4 — Visibility / dashboard MVP

| # | Decision | Rationale |
|---|----------|-----------|
| D31 | **Realtime plane = Redis pub/sub + counters** (`@conductor/realtime`), streamed to the browser via **SSE** from the gateway. | Matches spec §4 (Redis for progress + the realtime feed). SSE is simpler than WebSocket for one-way server→client streams and works through proxies. The worker publishes; the gateway subscribes and fans out per connection. |
| D32 | **Dual-write visibility**: the worker writes `job_logs`/`job_events`/`job_errors`/`batches`/`batch_chunks` to Postgres (queryable history) **and** publishes the same to Redis (live). | The dashboard fetches history via REST then streams live appends, deduping logs by `id` — no gaps, no missed events on reconnect. |
| D33 | **SSE auth via `?token=` query param** (EventSource can't set headers). The JWT is verified per connection; role ≥ viewer required. | Standard EventSource limitation. Token-in-query is acceptable here: TLS encrypts it in transit, it's short-lived, and no cookies are used (so no CSRF surface). Documented residual: query strings can appear in proxy logs — rotate to a short-lived stream token in prod. |
| D34 | **Cancellation = Redis flag + status machine**: running→`cancelling` (worker stops at the next chunk boundary, drops staging, marks `cancelled`); queued/retrying→`cancelled` directly (the delivered message is skipped via the idempotent claim). | Spec §13. Both paths verified live (queued-skip and mid-flight 2200/3000-row cancel with staging cleanup and zero leaked rows). |
| D35 | **Retry clones the job** into a fresh enqueue with a new idempotency key, rather than re-driving the original. | Keeps the original's audit trail intact; the clone flows through the same outbox→relay→worker path. |
| D36 | The **Jobs/Schedules lists refresh off the global activity SSE** (invalidate on event) instead of polling, with a slow 15s safety refetch. | "No manual refresh" (spec §15) without hammering the API. |

## Post-M4 adversarial review (6-dimension workflow, 61 raised / 50 confirmed)

A multi-agent review audited M1–M4 against the §5/§13 invariants. **Fixed immediately:**

| Ref | Fix |
|-----|-----|
| **C1, H7** | **SSRF DNS-rebinding/TOCTOU**: `assertHostAllowed` validated the resolved IP but callers re-resolved the hostname at connect. Now the connection is **pinned to the validated IP** (gateway test-connection + worker pool), with the hostname used only as TLS servername. Worker per-process SSRF cache removed (re-validates per pool creation). |
| H1 | Retry path could leave a message un-acked/un-nacked if the delayed re-publish threw, and set `retrying` before the copy was durable. Now: **publish-confirm first, then status + ack**; **nack-requeue on publish failure**; consume callback has a `.catch` safety net. |
| H3 | `publishWithConfirm` now has a **confirm timeout** so a dropped channel can't hang the relay's open transaction. |
| H4 | Staging table is now dropped in a **`finally`** — cleaned up on success, cancel, error, and retry/DLQ. |
| H5, H6 | Expression relational operators are **non-associative** (no boolean-into-Number bug); an **invalid regex** becomes a row error instead of crashing the chunk/job. |
| H8 | `?token=` is **redacted from logged request URLs** (pino req serializer). |
| H9 | Cancel is now **atomic**: set the Redis flag first, then conditional `UPDATE … WHERE status IN(…)` that cannot clobber a concurrent claim. |
| H10, H11 | Job **options/mapping persisted** on the job row; **retry clones options/ruleSetId/priority** faithfully. |
| H12 | `one_time` definitions now **require `runAt`** (no silently-never-firing schedules). |
| M7 | Integer coercion never passes `NaN`/floats to int columns (`Math.trunc`, finite-check). |
| M8 | Per-row **data/integrity errors (SQLSTATE 22/23) are collected as row errors**; only infrastructure errors abort the chunk. |
| M21 | **Retry guarded** to terminal jobs (failed/cancelled/completed) only. |
| L12, L15 | Pagination clamps NaN/negatives; search `q` **escapes ILIKE wildcards**. |

**Accepted as by-design or deferred (with rationale):**

| Ref | Disposition |
|-----|-------------|
| M1/M16 | Outbox relay publishes inside the row-locking tx and can re-publish if COMMIT fails after a broker ack. **By design**: this is the at-least-once guarantee — consumers are idempotent (atomic job claim + `ON CONFLICT DO NOTHING` promote), so duplicate delivery is safe. Holding locks across publish is a throughput item revisited under M6 fan-out. |
| M2 | Scheduler advances `next_run_at` from `now`, skipping runs missed during downtime. **By design** (no thundering-herd catch-up); a catch-up policy is a future option. |
| M3 | Exhausted outbox rows are marked `failed`; **M6** adds an outbox-DLQ + alert. |
| M14 | Target-DB TLS uses `rejectUnauthorized` only for `verify-full`. **M6 hardening** will tighten default TLS posture per provider. |
| M19 | Gateway accepts all 9 job types but only `bulk_import` has a handler today; the rest dead-letter. **M5** adds the remaining handlers + edge worker. |
| M22 | Worker resolves mapping/ruleSet from `project_entities`, ignoring `envelope.mapping`/`ruleSetId`. Intentional for now; **M5** wires ad-hoc envelope overrides. |
| L1, L2, L4, L9, others | Queue priority arg, composite-unique semantics, identifier-length guard, KEK-rotation via `keyId`, etc. — tracked for **M6 hardening**. |

## M5 — Remaining handlers & edge worker

| # | Decision | Rationale |
|---|----------|-----------|
| D37 | **Shared `@conductor/worker-runtime`** (generic Runner + reporter + context + `JobCancelled`) and **`@conductor/targetdb`** (pooled, SSRF-pinned Postgres + `quoteIdent`/`introspect`/`coerce`) are used by BOTH workers. | One implementation of the reliability shell and target-DB access — adding a worker = registering handlers, not re-implementing ack/retry/heartbeat/SSRF. |
| D38 | `bulk_import` / `bulk_insert` / `xml_integration` **share one staging→promote pipeline** parameterized by a **source reader** (csv / json / xml / inline). XML uses `recordPath` (e.g. `Customers.Customer`). | The three differ only in how rows are read; the validation/staging/promote correctness is identical and written once. |
| D39 | **`bulk_update`**: matches on `options.matchOn` (a target column; default a business key, else PK), writes mapped fields + `updated_at`, with **optimistic concurrency** when `options.optimisticColumn` + a row `_<col>` value are supplied (distinguishes `optimistic_conflict` from `not_found`). Rules still validate. | Spec §11. UPDATE is naturally idempotent. |
| D40 | **`bulk_delete`**: `options.dryRun` returns a would-delete **count** with no mutation; **soft-delete by default** (sets `deleted_at`); **hard-delete** only with `options.hardDelete` AND under a **safety threshold** (`options.maxDelete`, override `options.confirm`). | Spec §11 — destructive by exception, not default. |
| D41 | **Edge→core handoff**: `file_inbound` fetches → stages to object storage → **enqueues** a `bulk_import`/`xml_integration`; `rest_pull` paginates (backoff) → stages JSON → **enqueues** `bulk_insert`. The edge stays lightweight I/O; the rule/DB pipeline stays in core. | Spec §4 (edge = files/REST, core = rules + bulk DB). Clean separation, reuses the validated pipeline. |
| D42 | `file_outbound` / `rest_push` **read the target via the shared `@conductor/targetdb`** (filtering `deleted_at IS NULL`), serialize with **source-field headers** (round-trip friendly), and push to S3 / REST in batches with backoff. | A read/export is a light DB op; sharing `targetdb` avoids duplicating connection/SSRF logic. |
| D43 | A tiny dependency-free **`mock-rest`** service (`deploy/mock-rest`) backs the `rest_pull`/`rest_push` demos (paginated GET, batch POST). | Lets the REST handlers run end-to-end locally without an external API. |
| D44 | worker-core remains **PostgreSQL-target only**; MySQL/SQL Server target writers stay **M6**. The demo target is Postgres, satisfying M5 acceptance. | Avoids a multi-provider bulk-write abstraction before it's needed; the connection test already covers all three providers. |

## M6 — Concurrency, observability & hardening

| # | Decision | Rationale |
|---|----------|-----------|
| D45 | **Per-project concurrency** via a Redis semaphore (`acquireProjectSlot`, atomic Lua INCR+EXPIRE+rollback). Over-limit jobs are **deferred** (re-published with a short randomized delay) rather than run. | Spec §12 — protects each project's DB and gives fair throughput. Verified: limit=1 ⇒ max concurrent 1, all jobs still complete. |
| D46 | **Cross-worker chunk-message fan-out is NOT implemented**; bulk jobs chunk **in-process** with bounded concurrency, and parallelism comes from **multiple worker replicas + per-project limits**. | Satisfies the DoD ("multiple jobs in parallel across workers/projects, respecting limits") without the complexity of a per-chunk message protocol. Documented deviation from §12's fan-out detail. |
| D47 | **Throughput**: staging inserts use **multi-row INSERT** (sub-batched, capped under PG's 65535 bind-param limit) with **row-by-row fallback** on a constraint/data error to preserve per-row error attribution. | Makes the 1M-row load test tractable while keeping parallel-uniqueness/error semantics. |
| D48 | **Observability = Prometheus metrics + Grafana** (provisioned datasource + dashboard). `/metrics` on gateway (8080) + workers (9101/9102); Prometheus scrapes all three. **OTel distributed tracing is a fail-soft, opt-in integration point** (`telemetry/tracing.ts` dynamic-imports the SDK only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set) but the OTel auto-instrumentation packages are **not bundled** because their transitive deps carry CVEs. | Delivers "metrics visible" with a clean (0-vuln) build; tracing can be enabled by adding the OTel packages + a collector/Tempo. |
| D49 | **Dead-worker recovery** is done in `claimJob`: a redelivered message for a `running` job whose owning worker's heartbeat is **stale (>45s)** is reclaimed; a live owner's job is never reclaimed (no double-run). | Spec §13 reaper intent, triggered by RabbitMQ's redelivery on a dead worker's channel close. |
| D50 | **DLQ replay** resets the job to `queued` before re-publishing (else a `failed` job is skipped on delivery — a silent no-op); typeless/unparseable DLQ messages are **left in the DLQ**, never destroyed. | Makes the Workers-page replay actually reprocess; no data loss. |

### Post-M5/M6 review (33 raised / 23 confirmed) — fixed

C1 **edge SSRF** (REST handlers now run the deny-by-default guard + scheme check + `redirect:'manual'`; `mock-rest` is admin-allow-listed) · H1 atomic semaphore (Lua) · H2 dead-worker reclaim · H3 bind-param cap · H4/H5 DLQ replay reset + no-destroy · M5 empty-SET guard · M8 staging cleanup if create fails · M10 CSV header escaping · M11 no-retry on 4xx + jitter · M13 keyring id-collision guard.

## Standard scheduler presets (post-M6 enhancement)

| # | Decision | Rationale |
|---|----------|-----------|
| D51 | **Friendly recurrence presets** (`daily` / `weekly` / `monthly` with time-of-day, `hourly` at-minute, `every-N-minutes`, `one-time`, raw `cron`) via a `ScheduleSpec` in `@conductor/contracts`. `buildCron()` lowers the spec to the stored cron + `schedule_kind` the scheduler already fires; the original spec is kept in `options.schedule` for display. The job-definition API accepts `schedule` (preferred) **or** the legacy `scheduleKind`+`cron` (back-compat). | Spec §15's "cron builder" + the non-developer-operator persona — operators pick "Daily at 09:00", not a cron string. The conversion is one unit-tested helper (11 tests) shared by API + dashboard; the scheduler/firing path is unchanged. Verified: presets produce correct cron + `next_run_at`, and an every-minute preset fired end-to-end. |

### Accepted / deferred (documented)

| Ref | Disposition |
|-----|-------------|
| M2 | `rows_processed` metric re-reads batch sum per attempt — minor over-count on retries; acceptable for a counter. |
| M4 | Composite (multi-column) `unique` is enforced as independent single-column indexes. Composite-key uniqueness is a future rule-schema extension. |
| M6 | Optimistic-concurrency on timestamp columns compares as text — works for exact-match version tokens; richer typing later. |
| M7, M12 | hard-delete double-reads source for the threshold; rest_pull caps at 1000 pages — both bounded/benign; logged. |
| M9 | rest_push marks the job failed on partial push without auto-retry (avoids duplicate re-sends to a non-idempotent API); status/metrics are single-counted via the runner's final-status read. |
| L4 | `/metrics` is unauthenticated (standard for Prometheus scraping); exposes counts/topology, no secrets. Gate at the network layer in prod. |
| — | MySQL/SQL Server **target writers** still pending (Postgres-only); a periodic **reaper** for the rare alive-but-channel-dropped worker complements the redelivery-based reclaim. |
