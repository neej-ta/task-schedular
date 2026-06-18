import { query, closePool, provisionProjectSchema } from '@conductor/db';
import { getConnection, createConfirmChannel, closeConnection, assertProjectTopology } from '@conductor/messaging';
import { config, assertConfig } from './config.js';
import { DockerOrchestrator } from './docker.js';
import { dockerVersion } from './docker.js';
import { reconcileOnce, type ContainerState } from './reconcile.js';

const log = (msg: string, extra?: Record<string, unknown>) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), svc: 'provisioner', instance: config.instanceId, msg, ...extra }));

let running = true;

async function main() {
  assertConfig();

  if (!config.enabled) {
    // Inert: stay alive (so a supervisor doesn't treat exit as a crash) but do nothing.
    log('PROVISIONER_ENABLED is not true — idling, no containers will be managed');
    await new Promise<void>((resolve) => process.on('SIGTERM', () => resolve()));
    return;
  }

  log(`starting provisioner ${config.instanceId} (tick ${config.tickMs}ms)`);
  const ver = await dockerVersion();
  log(`connected to docker ${ver.version} (api ${ver.apiVersion}) via ${config.dockerSocket}`);

  const orchestrator = new DockerOrchestrator();
  const conn = await getConnection();
  const channel = await createConfirmChannel();

  const setState = async (projectId: string, state: ContainerState) => {
    await query(`UPDATE projects SET container_state=$2, updated_at=now() WHERE id=$1`, [projectId, state]);
  };

  const desiredProjectIds = async (): Promise<string[]> => {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM projects
        WHERE isolation_mode='dedicated' AND status='active' AND deleted_at IS NULL`,
    );
    return rows.map((r) => r.id);
  };

  // Provision schema + per-project queues BEFORE the worker container starts, so
  // no message is discarded by the direct exchange in the gap before it's up.
  const ensureProjectReady = async (projectId: string): Promise<string> => {
    const schema = await provisionProjectSchema(projectId);
    await assertProjectTopology(channel, projectId);
    return schema;
  };

  while (running) {
    try {
      const r = await reconcileOnce({ orchestrator, desiredProjectIds, ensureProjectReady, setState, log });
      if (r.created.length || r.removed.length || r.errored.length) {
        log('reconciled', { created: r.created.length, removed: r.removed.length, errored: r.errored.length });
      }
    } catch (err) {
      log(`reconcile tick error: ${(err as Error).message}`);
    }
    await sleep(config.tickMs);
  }

  await channel.close().catch(() => {});
  await closeConnection();
  await closePool();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

process.on('SIGTERM', () => { running = false; });
process.on('SIGINT', () => { running = false; });

main().catch((err) => {
  console.error('provisioner failed to start', err);
  process.exit(1);
});
