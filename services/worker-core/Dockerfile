# worker-core — rule-bearing handlers + bulk DB ops. Runs TS via tsx.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/security/package.json packages/security/
COPY packages/storage/package.json packages/storage/
COPY packages/messaging/package.json packages/messaging/
COPY packages/realtime/package.json packages/realtime/
COPY packages/rule-engine/package.json packages/rule-engine/
COPY packages/rule-conformance/package.json packages/rule-conformance/
COPY packages/targetdb/package.json packages/targetdb/
COPY packages/telemetry/package.json packages/telemetry/
COPY packages/worker-runtime/package.json packages/worker-runtime/
COPY services/worker-core/package.json services/worker-core/

RUN npm install --workspaces --include-workspace-root

COPY packages/contracts packages/contracts
COPY packages/db packages/db
COPY packages/security packages/security
COPY packages/storage packages/storage
COPY packages/messaging packages/messaging
COPY packages/realtime packages/realtime
COPY packages/rule-engine packages/rule-engine
COPY packages/rule-conformance packages/rule-conformance
COPY packages/targetdb packages/targetdb
COPY packages/telemetry packages/telemetry
COPY packages/worker-runtime packages/worker-runtime
COPY services/worker-core services/worker-core

ENV NODE_ENV=development

WORKDIR /app/services/worker-core
CMD ["npm", "run", "start"]
