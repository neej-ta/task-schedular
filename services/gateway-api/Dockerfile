# gateway-api — runs TypeScript directly via tsx for fast local iteration.
# (Production builds can add a tsc compile step; see docs/DECISIONS.md.)
FROM node:22-alpine

WORKDIR /app

# Install workspace deps. Copy the manifests that define the workspace graph so
# `npm ci` can resolve the local packages this service depends on.
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
COPY services/gateway-api/package.json services/gateway-api/

RUN npm install --workspaces --include-workspace-root

# Copy sources for the packages this service needs + the service itself.
COPY packages/contracts packages/contracts
COPY packages/db packages/db
COPY packages/core packages/core
COPY packages/security packages/security
COPY packages/storage packages/storage
COPY packages/realtime packages/realtime
COPY packages/messaging packages/messaging
COPY packages/telemetry packages/telemetry
COPY services/gateway-api services/gateway-api

ENV NODE_ENV=development
EXPOSE 8080

WORKDIR /app/services/gateway-api
CMD ["npm", "run", "start"]
