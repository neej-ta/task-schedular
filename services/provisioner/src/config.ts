import { hostname } from 'node:os';

// Provisioner config (M7 Phase 3). The provisioner watches for `dedicated`-tier
// projects and reconciles a dedicated worker container per project via the
// Docker Engine API. It is INERT unless PROVISIONER_ENABLED=true, so it never
// touches Docker in environments without a socket (incl. local dev / CI).
export const config = {
  enabled: process.env.PROVISIONER_ENABLED === 'true',
  instanceId: process.env.PROVISIONER_ID ?? `provisioner-${hostname()}`,
  tickMs: Number(process.env.PROVISIONER_TICK_MS ?? 10_000),

  // Docker Engine API over a local socket. Default is the Linux socket the app
  // container would mount; on a Windows host the npipe path can be supplied.
  dockerSocket: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
  // Optional API-version prefix, e.g. '/v1.43'. Empty = daemon default.
  dockerApiPrefix: process.env.DOCKER_API_PREFIX ?? '',

  // Spec for the per-project worker containers the provisioner creates.
  worker: {
    // Reuse the app image; override its CMD to run ONLY worker-core in project mode.
    image: process.env.DEDICATED_WORKER_IMAGE ?? 'conductor-app',
    // Must be the conductor stack network so the worker reaches postgres/rabbitmq/valkey by name.
    network: process.env.DEDICATED_WORKER_NETWORK ?? 'conductor_default',
    // Command run inside the container (the app image has tsx + sources at /app).
    cmd: (process.env.DEDICATED_WORKER_CMD ??
      'node --import tsx /app/services/worker-core/src/main.ts').split(' '),
    // Connection + secret env passed through from the provisioner's own env.
    databaseUrl: process.env.DATABASE_URL ?? '',
    rabbitmqUrl: process.env.RABBITMQ_URL ?? '',
    redisUrl: process.env.REDIS_URL ?? '',
    masterKey: process.env.CONDUCTOR_MASTER_KEY ?? '',
    masterKeyId: process.env.CONDUCTOR_MASTER_KEY_ID ?? '',
    // Extra passthrough (SSRF allowlist, log level, etc.) as a JSON object string.
    extraEnvJson: process.env.DEDICATED_WORKER_EXTRA_ENV ?? '{}',
  },
} as const;

// Labels every managed container carries — the ONLY containers the provisioner
// will ever list/stop/remove. Anything without these is out of scope.
export const LABEL_ROLE = 'conductor.role';
export const ROLE_VALUE = 'dedicated-worker';
export const LABEL_PROJECT = 'conductor.project';

export function assertConfig(): void {
  if (!config.enabled) return;
  for (const [k, v] of Object.entries({
    DATABASE_URL: config.worker.databaseUrl,
    RABBITMQ_URL: config.worker.rabbitmqUrl,
  })) {
    if (!v) throw new Error(`${k} is required when PROVISIONER_ENABLED=true`);
  }
}
