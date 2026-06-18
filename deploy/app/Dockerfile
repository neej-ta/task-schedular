# Conductor — single "app" image.
#
# Runs all four backend services (gateway-api, scheduler, worker-core,
# worker-edge) plus a folded-in mock-REST endpoint as supervised child
# processes, and serves the pre-built dashboard SPA from the gateway.
# This consolidates the former 5 app containers into 1 (see docker-compose.yml).
#
# Services run TypeScript directly via tsx for fast local iteration, matching
# the original per-service Dockerfiles.
FROM node:22-alpine

WORKDIR /app

# ── Install the full workspace dependency graph ─────────────────────────────
# Copy every manifest first so npm can resolve the local @conductor/* packages.
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/security/package.json packages/security/
COPY packages/storage/package.json packages/storage/
COPY packages/realtime/package.json packages/realtime/
COPY packages/messaging/package.json packages/messaging/
COPY packages/telemetry/package.json packages/telemetry/
COPY packages/rule-engine/package.json packages/rule-engine/
COPY packages/rule-conformance/package.json packages/rule-conformance/
COPY packages/targetdb/package.json packages/targetdb/
COPY packages/worker-runtime/package.json packages/worker-runtime/
COPY services/gateway-api/package.json services/gateway-api/
COPY services/scheduler/package.json services/scheduler/
COPY services/worker-core/package.json services/worker-core/
COPY services/worker-edge/package.json services/worker-edge/
COPY services/provisioner/package.json services/provisioner/
COPY dashboard/package.json dashboard/

RUN npm install --workspaces --include-workspace-root

# ── Copy sources ─────────────────────────────────────────────────────────────
COPY packages packages
COPY services services
COPY dashboard dashboard
COPY deploy/mock-rest deploy/mock-rest
COPY deploy/app/supervisor.mjs deploy/app/supervisor.mjs

# ── Build the dashboard SPA (served same-origin by the gateway) ─────────────
# VITE_API_BASE="" makes the bundle call the API with relative paths, so the
# dashboard talks to whatever origin served it (the gateway on :8080).
ENV VITE_API_BASE=""
RUN npm run build -w @conductor/dashboard

ENV NODE_ENV=development
# 8080 = gateway API + dashboard; 9101/9102 = worker Prometheus metrics.
EXPOSE 8080 9101 9102

CMD ["node", "deploy/app/supervisor.mjs"]
