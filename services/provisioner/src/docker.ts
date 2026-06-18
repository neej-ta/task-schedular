import http from 'node:http';
import { config, LABEL_ROLE, ROLE_VALUE, LABEL_PROJECT } from './config.js';
import { schemaForProject } from '@conductor/db';
import type { CreateSpec, ManagedContainer, Orchestrator } from './orchestrator.js';

// ─────────────────────────────────────────────────────────────────────────────
// Docker Engine API client over the local socket — dependency-free (Node http
// with `socketPath`). Only the handful of endpoints the provisioner needs.
//
// ⚠️ Security (DESIGN-isolation-tiers.md, D55): the Docker socket is
// root-equivalent host access. This client takes NO job-controlled input — only
// project ids (validated to UUID-derived schema names) and operator config — and
// only ever acts on containers carrying our role label. In production, front the
// socket with a scoped proxy that allows just create/start/stop/remove/list on
// `conductor.role=dedicated-worker` containers.
// ─────────────────────────────────────────────────────────────────────────────

interface DockerResponse {
  status: number;
  body: unknown;
}

function request(method: string, path: string, body?: unknown): Promise<DockerResponse> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: config.dockerSocket,
        method,
        path: `${config.dockerApiPrefix}${path}`,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let parsed: unknown = buf;
          try {
            parsed = buf ? JSON.parse(buf) : null;
          } catch {
            /* leave as raw text */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function ensureOk(res: DockerResponse, action: string, okStatuses = [200, 201, 204]): void {
  if (!okStatuses.includes(res.status)) {
    const msg = typeof res.body === 'object' && res.body && 'message' in res.body
      ? (res.body as { message: string }).message
      : JSON.stringify(res.body);
    throw new Error(`docker ${action} failed (${res.status}): ${msg}`);
  }
}

/** Read-only daemon probe — used by health checks / verification. */
export async function dockerVersion(): Promise<{ version: string; apiVersion: string }> {
  const res = await request('GET', '/version');
  ensureOk(res, 'version', [200]);
  const b = res.body as { Version?: string; ApiVersion?: string };
  return { version: b.Version ?? '?', apiVersion: b.ApiVersion ?? '?' };
}

interface DockerContainerSummary {
  Id: string;
  State: string;
  Labels?: Record<string, string>;
}

export class DockerOrchestrator implements Orchestrator {
  async list(): Promise<ManagedContainer[]> {
    // all=true so we also see stopped/exited managed containers (to restart/clean).
    const filters = encodeURIComponent(JSON.stringify({ label: [`${LABEL_ROLE}=${ROLE_VALUE}`] }));
    const res = await request('GET', `/containers/json?all=true&filters=${filters}`);
    ensureOk(res, 'list', [200]);
    const rows = (res.body as DockerContainerSummary[]) ?? [];
    return rows
      .map((c) => ({
        id: c.Id,
        projectId: c.Labels?.[LABEL_PROJECT] ?? '',
        state: (c.State ?? '').toLowerCase(),
      }))
      .filter((c) => c.projectId); // ignore anything missing our project label
  }

  async create(spec: CreateSpec): Promise<string> {
    const schema = schemaForProject(spec.projectId); // re-derive defensively
    const w = config.worker;
    const extra = JSON.parse(w.extraEnvJson) as Record<string, string>;
    const env = [
      `DATABASE_URL=${w.databaseUrl}`,
      `RABBITMQ_URL=${w.rabbitmqUrl}`,
      `REDIS_URL=${w.redisUrl}`,
      `CONDUCTOR_MASTER_KEY=${w.masterKey}`,
      `CONDUCTOR_MASTER_KEY_ID=${w.masterKeyId}`,
      `WORKER_MODE=project`,
      `WORKER_PROJECT_ID=${spec.projectId}`,
      `CONTROL_DB_SEARCH_PATH=${schema},public`,
      `WORKER_ID=dedicated-${schema}`,
      ...Object.entries(extra).map(([k, v]) => `${k}=${v}`),
    ];
    const name = `conductor-dedicated-${schema}`;

    const createRes = await request('POST', `/containers/create?name=${encodeURIComponent(name)}`, {
      Image: w.image,
      Cmd: w.cmd,
      Env: env,
      Labels: { [LABEL_ROLE]: ROLE_VALUE, [LABEL_PROJECT]: spec.projectId },
      HostConfig: {
        NetworkMode: w.network,
        RestartPolicy: { Name: 'unless-stopped' },
      },
    });
    ensureOk(createRes, 'create', [201]);
    const id = (createRes.body as { Id: string }).Id;

    const startRes = await request('POST', `/containers/${id}/start`);
    ensureOk(startRes, 'start', [204, 304]);
    return id;
  }

  async remove(containerId: string): Promise<void> {
    // Graceful stop (SIGTERM → worker drains; 30s) then force-remove.
    const stopRes = await request('POST', `/containers/${containerId}/stop?t=30`);
    ensureOk(stopRes, 'stop', [204, 304, 404]);
    const rmRes = await request('DELETE', `/containers/${containerId}?force=true`);
    ensureOk(rmRes, 'remove', [204, 404]);
  }
}
