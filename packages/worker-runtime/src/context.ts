import { query } from '@conductor/db';
import { RuleSetSchema, type JobEnvelope, type RuleSet } from '@conductor/contracts';
import type { ProjectConn } from '@conductor/targetdb';

export interface EntityConfig {
  name: string;
  targetTable: string;
  primaryKey: string;
  mapping: Record<string, string>; // sourceField -> targetColumn
  ruleSetId: string | null;
}

export interface JobRow {
  id: string;
  project_id: string;
  entity: string;
  type: string;
  attempt: number;
  max_attempts: number;
  source_jsonb: Record<string, unknown>;
  destination_jsonb: Record<string, unknown>;
  parameters_jsonb: Record<string, unknown>;
}

export interface JobContext {
  envelope: JobEnvelope;
  job: JobRow;
  project: ProjectConn;
  entity: EntityConfig;
  ruleSet: RuleSet;
}

/** Resolve everything a handler needs: job + project (with secret) + entity + rules. */
export async function resolveContext(envelope: JobEnvelope): Promise<JobContext> {
  const { rows: jobRows } = await query<JobRow>('SELECT * FROM jobs WHERE id=$1', [envelope.jobId]);
  const job = jobRows[0];
  if (!job) throw new Error(`job ${envelope.jobId} not found`);

  const { rows: projRows } = await query<ProjectConn>(
    `SELECT id, provider, host, port, database, schema, username, secret_ciphertext,
            ssl_mode, pool_max, query_timeout_s, allowlist_hosts
       FROM projects WHERE id=$1 AND deleted_at IS NULL`,
    [job.project_id],
  );
  const project = projRows[0];
  if (!project) throw new Error(`project ${job.project_id} not found`);

  // Entity-less job types (e.g. `webhook`) don't operate on a project entity/
  // table — they trigger the project's own endpoint. Skip the entity/rule-set
  // resolution and return a stub so these jobs don't require a project_entities
  // row.
  const ENTITYLESS_TYPES = new Set(['webhook']);
  if (ENTITYLESS_TYPES.has(job.type)) {
    return {
      envelope,
      job,
      project,
      entity: { name: job.entity, targetTable: '', primaryKey: '', mapping: {}, ruleSetId: null },
      ruleSet: { ruleSetId: 'none', rules: [], transforms: [] },
    };
  }

  const { rows: entRows } = await query<{
    name: string;
    target_table: string;
    primary_key: string;
    mapping_jsonb: Record<string, string>;
    rule_set_id: string | null;
  }>(`SELECT name, target_table, primary_key, mapping_jsonb, rule_set_id
        FROM project_entities WHERE project_id=$1 AND name=$2`, [job.project_id, job.entity]);
  const ent = entRows[0];
  if (!ent) throw new Error(`entity '${job.entity}' not configured for project ${job.project_id}`);

  const entity: EntityConfig = {
    name: ent.name,
    targetTable: ent.target_table,
    primaryKey: ent.primary_key,
    mapping: ent.mapping_jsonb ?? {},
    ruleSetId: ent.rule_set_id,
  };

  let ruleSet: RuleSet = { ruleSetId: 'none', rules: [], transforms: [] };
  if (entity.ruleSetId) {
    const { rows: rsRows } = await query<{ rules_jsonb: unknown }>(
      'SELECT rules_jsonb FROM rule_sets WHERE id=$1',
      [entity.ruleSetId],
    );
    if (rsRows[0]) {
      ruleSet = RuleSetSchema.parse({ ruleSetId: entity.ruleSetId, ...(rsRows[0].rules_jsonb as object) });
    }
  }

  return { envelope, job, project, entity, ruleSet };
}
