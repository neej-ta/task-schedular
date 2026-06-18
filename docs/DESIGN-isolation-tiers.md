# Design — Per-Project Isolation Tiers (M7)

**Status:** proposed (design only; no code yet)
**Author:** design discussion, 2026-06-17
**Supersedes:** the "single `app` container / ≤5 containers" dev-stack constraint
(see DECISIONS **D52** — consciously relaxed for the `dedicated` tier).

## Goal

Let every project choose how strongly it is isolated, **without changing the
existing system for projects that don't opt in**:

- **`shared` (default, = today):** one shared scheduler + worker pool. Projects
  are isolated logically by `project_id` and a per-project Redis concurrency
  semaphore (D45). No new infrastructure.
- **`dedicated` (new, opt-in):** the project gets its **own worker container**
  (provisioned on demand via the Docker Engine API) and its **own Postgres
  schema** for execution data. Strongest isolation; provisioned per project.

This is **additive**: `dedicated` is a tier layered on top. The control plane,
data model, idempotency, retry/DLQ, and rule pipeline are all reused unchanged.

## What stays central vs. per-project

| Concern | `shared` | `dedicated` |
|---|---|---|
| Project / connection metadata | control DB | control DB |
| **Schedules** (`job_definitions`) | control DB | **control DB** (so the one global leader scheduler is unchanged) |
| Enqueue + outbox | control DB | control DB |
| **Execution data** (jobs/job_events/job_logs/job_errors/batches/batch_chunks/results) | control DB | **per-project schema** `proj_<id>` |
| Queues | `conductor.q.<type>` (shared) | `conductor.q.<type>.p.<projectId>` (dedicated) |
| Concurrency | Redis semaphore (D45) | the dedicated container's own prefetch (no semaphore) |
| Worker process | shared pool | one container per project (Docker Engine API) |

> **Why schedules stay central:** the scheduler does a single global query over
> `job_definitions` ([services/scheduler/src/scheduler.ts](../services/scheduler/src/scheduler.ts)).
> Keeping schedules in the control DB means the existing global-leader model
> (D15) needs **no change**. Only *where the resulting run-state is written*
> differs, and that is decided downstream at enqueue/execute time.

## Routing — the single branch point

Queue selection is the only place the tier changes the hot path. Today
([packages/contracts/src/common.ts](../packages/contracts/src/common.ts)):

```
queueForType('bulk_import')  ->  conductor.q.bulk_import        (all projects)
```

Becomes tier-aware, decided in
[packages/core/src/enqueue.ts](../packages/core/src/enqueue.ts) (which already
has `projectId`; it looks up `isolation_mode`, cached like the runner caches
`concurrency_limit`):

```
shared:     conductor.q.bulk_import
dedicated:  conductor.q.bulk_import.p.<projectId>
```

Both callers of `enqueueJob` — the scheduler and the gateway ad-hoc path
([services/gateway-api/src/routes/jobs.ts](../services/gateway-api/src/routes/jobs.ts))
— inherit this automatically. No changes in either caller.

## Worker run modes

[packages/worker-runtime/src/runner.ts](../packages/worker-runtime/src/runner.ts)
gains a run mode:

- **`shared`** (today): binds `conductor.q.<type>` for its registered types,
  keeps the per-project Redis semaphore so no single project hogs the pool.
- **`project`** (new): launched for one `projectId`; binds only
  `conductor.q.<type>.p.<projectId>`; skips the semaphore (the container *is*
  the isolation); resolves its execution schema via `search_path=proj_<id>`.

## Per-project schema

On promotion to `dedicated`:

1. `CREATE SCHEMA proj_<id>`.
2. Apply the **execution-table** subset of migrations into that schema
   (jobs, job_events, job_logs, job_errors, batches, batch_chunks, results).
   Control-plane tables (projects, job_definitions, outbox, audit) stay in
   `public`.
3. A connection/schema registry keyed by `projectId` lets the dedicated worker
   set its `search_path`. The enqueue/outbox path still writes the outbox in the
   control DB; the worker writes run-state to the project schema.

## Provisioner service (new)

`services/provisioner` — a reconcile loop:

- **Desired state:** `SELECT id FROM projects WHERE isolation_mode='dedicated'`.
- **Actual state:** containers labelled `conductor.project=<id>` via the Docker
  Engine API.
- **Reconcile:** create a worker container on promote; `drain → stop → remove`
  on demote/delete. Reflect status in `projects.container_state`.

### ⚠️ Security note — Docker socket

Talking to the Docker Engine API means mounting the Docker socket, which grants
**root-equivalent host access**. In a codebase that is otherwise careful about
egress (deny-by-default SSRF, D9), this is the single largest new privilege
surface. Mitigations to design in: a scoped socket proxy (allow only
container create/stop/inspect with the `conductor.project` label), run the
provisioner as the only component with socket access, and never expose it to
job-controlled input.

## Phased delivery (each phase shippable; `shared` keeps working throughout)

1. **Routing tier** ✅ **done** — `isolation_mode` column (migration `0003`) +
   tier-aware `routingKeyForType`/`queueForType` + tier lookup in `enqueueJob` +
   worker `shared`/`project` run-mode (`WORKER_MODE`/`WORKER_PROJECT_ID`) +
   `assertProjectTopology`. Verified live: dedicated jobs route to
   `conductor.q.<type>.p.<id>` and a project-mode consumer drains them; shared
   unchanged.
2. **Per-project schema** ✅ **done** — `provisionProjectSchema`/
   `dropProjectSchema` + `schemaForProject` (`@conductor/db`) create the six
   execution tables in `proj_<id>` (cross-schema FKs to `public`); `enqueueJob`
   sets `SET LOCAL search_path` so a dedicated job's `jobs`/`job_events` land in
   the project schema while `outbox` stays in `public` (one transaction); the
   worker pool honors `CONTROL_DB_SEARCH_PATH=proj_<id>,public` via a libpq
   startup option. Verified live: rows land in the project schema, not `public`;
   a worker on that search_path sees and claims them.
3. **Provisioner service** ✅ **done (code)** — `services/provisioner`: an
   `Orchestrator` interface, a dependency-free Docker Engine API client over the
   socket (`DockerOrchestrator`, label-scoped to `conductor.role=dedicated-worker`),
   and a pure `reconcileOnce` loop (desired = active dedicated projects; actual =
   managed containers) that promotes (provision schema + assert per-project
   topology → create+start), restarts stale, and demotes (stop+remove), tracking
   `container_state`. INERT unless `PROVISIONER_ENABLED=true`. Verified: reconcile
   unit tests (promote/idempotent/stale/demote/error-isolation) pass; the Docker
   client connects to a real daemon and label-filtered `list()` returns 0.
   *Not yet exercised:* actually spawning a dedicated container end-to-end — needs
   the app image rebuilt with the Phase-1/2 code (Phase 4 deployment).
4. **Builder wiring + lifecycle** ✅ **done (app-level)** — admin
   `POST /projects/:id/isolation {mode}` endpoint promotes (provisions schema
   synchronously, marks `dedicated`/`provisioning`) / demotes (marks `shared`/
   `stopping`, schema retained); the Connections page shows a tier badge +
   `container_state` and an admin "Make dedicated / Make shared" toggle; the
   provisioner runs as a supervised process (inert unless `PROVISIONER_ENABLED`),
   and `docker-compose.yml` mounts the Docker socket + sets the worker image/
   network. **Verified end-to-end live** (2026-06-17): app image rebuilt with the
   M7 code and brought up with `PROVISIONER_ENABLED=true`; the provisioner
   connected to Docker, provisioned a dedicated project's schema, and spawned a
   `conductor-dedicated-proj_<id>` container that consumed its per-project queues
   and drained the enqueued job; on project delete the provisioner stopped+removed
   the container and set `container_state=stopped`. **Still pending:** the scoped
   Docker-socket proxy (D55/D56 hardening) and the tier-aware dashboard read path
   (Phase 2b — dedicated jobs in their own schema don't yet show in global views).

### Known gaps to close in a later sub-phase (2b / 4)

- **Gateway read path / global views.** The dashboard's cross-project Jobs /
  Activity queries read `public.jobs` etc. and will NOT see a dedicated project's
  jobs (they're in `proj_<id>`). Needs per-project-aware reads (set search_path
  per request when scoped to a dedicated project, or UNION across schemas for
  global views). Shared projects are unaffected.
- **Pre-declared queues on promote.** A dedicated project's jobs are discarded by
  the direct exchange if enqueued before its per-project queue exists. The
  provisioner (Phase 3) must `assertProjectTopology` + `provisionProjectSchema`
  at promote time, before the first enqueue.
- **Per-schema migration drift.** New execution-table columns must be applied to
  every `proj_<id>` schema, not just `public`. Track a `_migrations`-equivalent
  per schema (or re-run the idempotent DDL on boot).

## Invariants preserved (spec §5/§13)

All existing invariants hold unchanged: scheduler enqueues only; transactional
outbox; at-least-once + idempotent handlers; DB-enforced bulk correctness;
secrets encrypted/SSRF deny-by-default. The dedicated tier changes *where work
runs and where run-state is stored*, not *how correctness is guaranteed*.

## Open questions / deferred

- Multi-host: Docker-Engine-API provisioning is single-host by design. A
  Kubernetes backend behind the same provisioner interface is the multi-host
  successor (not in M7).
- Per-project schema migration drift: the execution-table migration set must be
  versioned per schema (track `_migrations` inside each `proj_<id>`).
- Demotion data: on `dedicated → shared`, decide whether to migrate the
  project schema's history back to `public` or retain it read-only.
