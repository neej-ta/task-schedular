// Orchestrator abstraction (M7 Phase 3). The reconcile loop talks to this
// interface, not to Docker directly — so the logic is unit-testable against an
// in-memory fake, and a future Kubernetes backend can drop in behind the same
// shape (DESIGN-isolation-tiers.md "open questions").

/** A provisioner-managed container, as discovered from the backend. */
export interface ManagedContainer {
  id: string;
  projectId: string;
  /** Backend state, normalized to lowercase ('running' | 'exited' | 'created' | …). */
  state: string;
}

/** Everything needed to create one dedicated worker for a project. */
export interface CreateSpec {
  projectId: string;
  /** The project's execution schema (proj_<hex>); set as CONTROL_DB_SEARCH_PATH. */
  schema: string;
}

export interface Orchestrator {
  /** List ONLY provisioner-managed containers (filtered by our role label). */
  list(): Promise<ManagedContainer[]>;
  /** Create + start a dedicated worker; returns the new container id. */
  create(spec: CreateSpec): Promise<string>;
  /** Stop (with grace) + remove a container by id. */
  remove(containerId: string): Promise<void>;
}
