# Runbook

Operational procedures. Expands as later milestones add the queue/worker plane.

## Local stack

```bash
docker compose up --build          # start everything
docker compose down                # stop (keep volumes)
docker compose down -v             # stop + wipe data volumes (fresh DB)
docker compose logs -f gateway-api # tail a service
```

Service URLs:

| URL | What |
|-----|------|
| http://localhost:5174 | Dashboard |
| http://localhost:8080 | Gateway API |
| http://localhost:8080/healthz, /readyz | Liveness / readiness |
| http://localhost:15672 | RabbitMQ management (conductor / conductor_dev_pw) |
| http://localhost:9001 | MinIO console (conductor / conductor_dev_pw) |
| http://localhost:9090 | Prometheus |
| http://localhost:3001 | Grafana (admin / admin; anonymous viewer enabled) — "Conductor" dashboard |
| http://localhost:8080/metrics | Prometheus metrics (gateway) |
| http://localhost:9101,9102/metrics | Worker metrics (core, edge) |

## Per-project concurrency

Each project has a `concurrency_limit` (PATCH `/projects/:id`). Workers enforce it
via a Redis semaphore (`conductor:running:<projectId>`); over-limit jobs are
re-queued with a short delay rather than run. Verify: set a project's limit to 1,
fire several jobs, and the running count never exceeds 1.

## DLQ replay

Workers page → **Replay DLQ**, or `POST /dlq/replay {"max":100}`. Replay resets
each job to `queued` and re-publishes it by type; unparseable messages stay in the
DLQ. Inspect depth: `rabbitmqctl list_queues name messages | grep dlq`.

## Secret-key (KEK) rotation

Set `CONDUCTOR_MASTER_KEY_PREVIOUS` + `CONDUCTOR_MASTER_KEY_PREVIOUS_ID` to the old
key, and `CONDUCTOR_MASTER_KEY` + `CONDUCTOR_MASTER_KEY_ID` to the new one. Existing
ciphertext decrypts via its stored `keyId` (the previous key); `PATCH` each project's
secret to re-wrap it under the new key, then drop the previous key.

Seeded logins: `admin@conductor.local/admin123`, `operator@.../operator123`,
`viewer@.../viewer123`.

## Database

Migrations run automatically on gateway-api boot (`AUTO_MIGRATE=true`). To run
them as a standalone step (the production pattern):

```bash
docker compose run --rm gateway-api npm run migrate -w @conductor/db
```

Reseed dev data (idempotent):

```bash
docker compose exec gateway-api npm run seed
```

## Rotate the secret-encryption master key (envelope KEK)

The stored blob records the `keyId` that wrapped each DEK, so rotation is
incremental:

1. Provision a new key; set `CONDUCTOR_MASTER_KEY` (new) + keep the old one
   available to the decrypt path (multi-key support is added when first needed).
2. Re-encrypt each project's secret: decrypt with the old KEK, `PATCH /projects/:id`
   with the same secret value → it is re-wrapped under the new `keyId`.
3. Retire the old key once no `secret_key_id` references it.

> Never log or export plaintext secrets during rotation.

## Scheduler clustering & failover (M2)

Run multiple scheduler replicas for HA:

```bash
docker compose up -d --scale scheduler=2
```

Only the **leader** (holder of the Postgres advisory lock) fires schedules; the
others stand by and all run the outbox relay. If the leader dies, its DB session
closes, the lock releases, and a standby acquires it within one tick (~5s). A
deterministic idempotency key per occurrence (`sched:<defId>:<occurrenceISO>`)
plus a UNIQUE index guarantees no double-fire even during the brief overlap.

Verify which instance is leader:

```bash
docker compose logs scheduler | grep "acquired leadership"
```

## Inspecting the queue plane (M2)

```bash
docker compose exec rabbitmq rabbitmqctl list_queues name messages   # depths
docker compose exec postgres psql -U conductor -d conductor \
  -c "SELECT status, count(*) FROM outbox GROUP BY status;"          # outbox drain
```

RabbitMQ topology: `conductor.jobs` (direct) + `conductor.delayed`
(x-delayed-message) → per-type `conductor.q.<type>`; each dead-letters to
`conductor.dlx` (fanout) → `conductor.dlq`.

## DLQ replay _(worker plane lands M3)_

Inspect the DLQ in the RabbitMQ UI (http://localhost:15672) or via
`rabbitmqctl list_queues`. Re-publish from `conductor.dlq` back to `conductor.jobs`
once the worker exists; the dashboard Workers page gets a replay button in M6.

## Scaling _(M6)_

Workers scale horizontally — run N replicas of `worker-core` / `worker-edge`;
RabbitMQ load-balances. Per-project `concurrency_limit` protects target DBs.

## Incident: a connection test fails

1. Check the error returned by `POST /projects/:id/test-connection`.
2. If "blocked: address is in a denied range" → the target resolves to a
   private/loopback IP and isn't allow-listed. An Admin adds the host/CIDR to the
   project's allow-list (or global `SSRF_ALLOWLIST`).
3. Otherwise it's a real connectivity/credential issue against the target DB.
