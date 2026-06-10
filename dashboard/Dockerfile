# dashboard — Vite dev server for local development.
# (Production would build static assets and serve via nginx; see docs/DECISIONS.md.)
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY dashboard/package.json dashboard/

RUN npm install --workspaces --include-workspace-root

COPY dashboard dashboard

WORKDIR /app/dashboard
EXPOSE 5173
CMD ["npm", "run", "dev"]
