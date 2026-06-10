# scheduler (+ outbox-relay) — runs TypeScript directly via tsx.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/messaging/package.json packages/messaging/
COPY packages/core/package.json packages/core/
COPY services/scheduler/package.json services/scheduler/

RUN npm install --workspaces --include-workspace-root

COPY packages/contracts packages/contracts
COPY packages/db packages/db
COPY packages/messaging packages/messaging
COPY packages/core packages/core
COPY services/scheduler services/scheduler

ENV NODE_ENV=development

WORKDIR /app/services/scheduler
CMD ["npm", "run", "start"]
