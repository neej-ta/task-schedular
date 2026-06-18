import type { Orchestrator } from './orchestrator.js';

// Pure reconcile step (M7 Phase 3). Drives actual state (managed containers)
// toward desired state (the set of dedicated projects). Side effects — DB reads,
// schema provisioning, topology assertion, state writes — are injected as `deps`
// so this is unit-testable against an in-memory orchestrator.
//
// container_state lifecycle per project:
//   promote   → 'provisioning' → (schema + topology + create) → 'running'
//   demote    → 'stopping' → (stop + remove) → 'stopped'
//   on error  → 'error' (loop retries next tick; one bad project never blocks others)

export type ContainerState = 'provisioning' | 'running' | 'stopping' | 'stopped' | 'error';

export interface ReconcileDeps {
  orchestrator: Orchestrator;
  /** Active, non-deleted dedicated project ids. */
  desiredProjectIds: () => Promise<string[]>;
  /** Provision schema + assert per-project queue topology BEFORE the worker starts. Returns the schema. */
  ensureProjectReady: (projectId: string) => Promise<string>;
  setState: (projectId: string, state: ContainerState) => Promise<void>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface ReconcileResult {
  created: string[];
  removed: string[];
  errored: string[];
}

export async function reconcileOnce(deps: ReconcileDeps): Promise<ReconcileResult> {
  const { orchestrator, desiredProjectIds, ensureProjectReady, setState, log } = deps;
  const result: ReconcileResult = { created: [], removed: [], errored: [] };

  const desired = new Set(await desiredProjectIds());
  const actual = await orchestrator.list();
  const byProject = new Map<string, (typeof actual)[number]>();
  for (const c of actual) byProject.set(c.projectId, c);

  // 1. Ensure a running worker for every desired project.
  for (const projectId of desired) {
    const existing = byProject.get(projectId);
    if (existing && existing.state === 'running') continue; // already healthy
    try {
      if (existing) {
        // Exists but not running (exited/created/dead) — clear it and recreate.
        log(`removing stale container for ${projectId} (state=${existing.state})`);
        await orchestrator.remove(existing.id);
      }
      await setState(projectId, 'provisioning');
      const schema = await ensureProjectReady(projectId);
      await orchestrator.create({ projectId, schema });
      await setState(projectId, 'running');
      result.created.push(projectId);
      log(`provisioned dedicated worker for ${projectId} (${schema})`);
    } catch (err) {
      result.errored.push(projectId);
      await setState(projectId, 'error').catch(() => {});
      log(`failed to provision ${projectId}: ${(err as Error).message}`);
    }
  }

  // 2. Tear down workers for projects no longer dedicated.
  for (const c of actual) {
    if (desired.has(c.projectId)) continue;
    try {
      await setState(c.projectId, 'stopping');
      await orchestrator.remove(c.id);
      await setState(c.projectId, 'stopped');
      result.removed.push(c.projectId);
      log(`removed dedicated worker for ${c.projectId} (demoted/deleted)`);
    } catch (err) {
      result.errored.push(c.projectId);
      await setState(c.projectId, 'error').catch(() => {});
      log(`failed to remove container for ${c.projectId}: ${(err as Error).message}`);
    }
  }

  return result;
}
