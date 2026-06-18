import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileOnce, type ContainerState } from './reconcile.js';
import type { CreateSpec, ManagedContainer, Orchestrator } from './orchestrator.js';

// In-memory orchestrator + dep harness — no Docker, no DB.
function harness(opts: {
  desired: string[];
  initial?: ManagedContainer[];
  failReadyFor?: Set<string>;
}) {
  let seq = 0;
  const containers: ManagedContainer[] = [...(opts.initial ?? [])];
  const states: Record<string, ContainerState> = {};
  const calls = { create: [] as string[], remove: [] as string[], ready: [] as string[] };

  const orchestrator: Orchestrator = {
    async list() {
      return containers.map((c) => ({ ...c }));
    },
    async create(spec: CreateSpec) {
      calls.create.push(spec.projectId);
      const id = `c${++seq}`;
      containers.push({ id, projectId: spec.projectId, state: 'running' });
      return id;
    },
    async remove(id: string) {
      const c = containers.find((x) => x.id === id);
      if (c) calls.remove.push(c.projectId);
      const i = containers.findIndex((x) => x.id === id);
      if (i >= 0) containers.splice(i, 1);
    },
  };

  const deps = {
    orchestrator,
    desiredProjectIds: async () => opts.desired,
    ensureProjectReady: async (projectId: string) => {
      calls.ready.push(projectId);
      if (opts.failReadyFor?.has(projectId)) throw new Error('boom');
      return `proj_${projectId.replace(/-/g, '')}`;
    },
    setState: async (projectId: string, state: ContainerState) => {
      states[projectId] = state;
    },
    log: () => {},
  };

  return { deps, containers, states, calls };
}

const PID_A = '11111111-1111-1111-1111-111111111111';
const PID_B = '22222222-2222-2222-2222-222222222222';

test('promote: creates a worker for a new dedicated project', async () => {
  const h = harness({ desired: [PID_A] });
  const r = await reconcileOnce(h.deps);
  assert.deepEqual(r.created, [PID_A]);
  assert.deepEqual(h.calls.create, [PID_A]);
  assert.deepEqual(h.calls.ready, [PID_A]); // schema + topology readied before create
  assert.equal(h.states[PID_A], 'running');
});

test('idempotent: a running worker is left alone', async () => {
  const h = harness({ desired: [PID_A], initial: [{ id: 'c0', projectId: PID_A, state: 'running' }] });
  const r = await reconcileOnce(h.deps);
  assert.deepEqual(r.created, []);
  assert.deepEqual(h.calls.create, []);
  assert.deepEqual(h.calls.remove, []);
});

test('stale: an exited worker is removed and recreated', async () => {
  const h = harness({ desired: [PID_A], initial: [{ id: 'c0', projectId: PID_A, state: 'exited' }] });
  const r = await reconcileOnce(h.deps);
  assert.deepEqual(h.calls.remove, [PID_A]);
  assert.deepEqual(h.calls.create, [PID_A]);
  assert.deepEqual(r.created, [PID_A]);
  assert.equal(h.states[PID_A], 'running');
});

test('demote: a no-longer-desired worker is stopped + removed', async () => {
  const h = harness({ desired: [], initial: [{ id: 'c0', projectId: PID_A, state: 'running' }] });
  const r = await reconcileOnce(h.deps);
  assert.deepEqual(r.removed, [PID_A]);
  assert.deepEqual(h.calls.remove, [PID_A]);
  assert.equal(h.states[PID_A], 'stopped');
});

test('error isolation: one failing project does not block the others', async () => {
  const h = harness({ desired: [PID_A, PID_B], failReadyFor: new Set([PID_A]) });
  const r = await reconcileOnce(h.deps);
  assert.deepEqual(r.errored, [PID_A]);
  assert.deepEqual(r.created, [PID_B]); // B still provisioned
  assert.equal(h.states[PID_A], 'error');
  assert.equal(h.states[PID_B], 'running');
});
