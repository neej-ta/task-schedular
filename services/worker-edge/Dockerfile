# worker-edge — integration handlers (files / REST). Runs TS via tsx.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/security/package.json packages/security/
COPY packages/storage/package.json packages/storage/
# (security already copied above; storage below)
COPY packages/messaging/package.json packages/messaging/
COPY packages/realtime/package.json packages/realtime/
COPY packages/targetdb/package.json packages/targetdb/
COPY packages/telemetry/package.json packages/telemetry/
COPY packages/worker-runtime/package.json packages/worker-runtime/
COPY services/worker-edge/package.json services/worker-edge/

RUN npm install --workspaces --include-workspace-root

COPY packages/contracts packages/contracts
COPY packages/db packages/db
COPY packages/core packages/core
COPY packages/security packages/security
COPY packages/storage packages/storage
COPY packages/messaging packages/messaging
COPY packages/realtime packages/realtime
COPY packages/targetdb packages/targetdb
COPY packages/telemetry packages/telemetry
COPY packages/worker-runtime packages/worker-runtime
COPY services/worker-edge services/worker-edge

ENV NODE_ENV=development

WORKDIR /app/services/worker-edge
CMD ["npm", "run", "start"]
