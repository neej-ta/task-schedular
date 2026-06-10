// Conductor app supervisor — runs the four backend services plus the folded-in
// mock-REST endpoint as child processes inside a single container.
//
// Design goals:
//   * Direct signal delivery — children are plain `node --import tsx <entry>`
//     processes, so SIGTERM reaches each service's own graceful-shutdown
//     handler (release leader lock, drain queues, close pools).
//   * Fail loud — if ANY child exits unexpectedly, tear the whole container
//     down with a non-zero code rather than running silently degraded.
//   * Per-service env — worker-core and worker-edge need distinct METRICS_PORT
//     / PREFETCH values that used to come from separate compose services.
//
// No npm dependencies (runs before/without a build step).
import { spawn } from 'node:child_process';

const ROOT = '/app';
const tsxArgs = (entry) => ['--import', 'tsx', `${ROOT}/${entry}`];

// Order matters only loosely: the gateway runs migrations on boot; the workers
// poll for the schema (waitForSchema) and the scheduler's loops swallow
// transient startup errors, so strict ordering isn't required.
const SERVICES = [
  {
    name: 'gateway-api',
    cwd: `${ROOT}/services/gateway-api`,
    args: tsxArgs('services/gateway-api/src/server.ts'),
    env: { SERVE_DASHBOARD: 'true' },
  },
  {
    name: 'scheduler',
    cwd: `${ROOT}/services/scheduler`,
    args: tsxArgs('services/scheduler/src/main.ts'),
    env: {},
  },
  {
    name: 'worker-core',
    cwd: `${ROOT}/services/worker-core`,
    args: tsxArgs('services/worker-core/src/main.ts'),
    // Knobs that previously lived on the separate worker-core compose service.
    env: { METRICS_PORT: '9101', PREFETCH: '2', CHUNK_CONCURRENCY: '4', NODE_OPTIONS: '--max-old-space-size=2048' },
  },
  {
    name: 'worker-edge',
    cwd: `${ROOT}/services/worker-edge`,
    args: tsxArgs('services/worker-edge/src/main.ts'),
    env: { METRICS_PORT: '9102', PREFETCH: '8' },
  },
  {
    // Folded-in stand-in for an external REST API (rest_pull / rest_push demos).
    // Reachable at 127.0.0.1:4000, which the workers' SSRF allowlist permits.
    name: 'mock-rest',
    cwd: ROOT,
    args: [`${ROOT}/deploy/mock-rest/server.mjs`],
    env: { PORT: '4000', RECORDS: '7' },
  },
];

const children = [];
let shuttingDown = false;

function log(msg) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), svc: 'supervisor', msg }));
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (exit code ${code})`);

  let remaining = children.filter(({ child }) => child.exitCode === null && !child.killed).length;
  if (remaining === 0) process.exit(code);

  for (const { child } of children) {
    if (child.exitCode === null && !child.killed) {
      child.on('exit', () => {
        if (--remaining === 0) process.exit(code);
      });
      child.kill('SIGTERM');
    }
  }

  // Hard backstop in case a child ignores SIGTERM.
  const t = setTimeout(() => {
    for (const { child } of children) if (child.exitCode === null) child.kill('SIGKILL');
    process.exit(code);
  }, 15000);
  t.unref();
}

for (const svc of SERVICES) {
  const child = spawn(process.execPath, svc.args, {
    cwd: svc.cwd,
    env: { ...process.env, ...svc.env },
    stdio: 'inherit',
  });
  children.push({ name: svc.name, child });
  log(`started ${svc.name} (pid ${child.pid})`);

  child.on('exit', (exitCode, signal) => {
    if (shuttingDown) return;
    log(`${svc.name} exited unexpectedly (code=${exitCode}, signal=${signal}); tearing down`);
    shutdown(exitCode == null ? 1 : exitCode);
  });
  child.on('error', (err) => {
    if (shuttingDown) return;
    log(`${svc.name} failed to spawn: ${err.message}`);
    shutdown(1);
  });
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
