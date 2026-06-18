import { query } from '@conductor/db';

// project_entities config: maps an entity name (the job's `entity`) to a target
// table + a field mapping (sourceColumn -> targetColumn) the worker uses to
// import/update/export. One per (project, name) — see 0001_init.sql.

export interface EntityRow {
  id: string;
  project_id: string;
  name: string;
  target_table: string;
  primary_key: string;
  rule_set_id: string | null;
  mapping_jsonb: Record<string, string>;
}

export async function listEntities(projectId: string): Promise<EntityRow[]> {
  const { rows } = await query<EntityRow>(
    `SELECT id, project_id, name, target_table, primary_key, rule_set_id, mapping_jsonb
       FROM project_entities WHERE project_id = $1 ORDER BY name`,
    [projectId],
  );
  return rows;
}

export interface UpsertEntityInput {
  projectId: string;
  name: string;
  targetTable: string;
  primaryKey: string;
  mapping: Record<string, string>;
  ruleSetId?: string | null;
}

/** Create or update (by project+name) an entity mapping. */
export async function upsertEntity(i: UpsertEntityInput): Promise<EntityRow> {
  const { rows } = await query<EntityRow>(
    `INSERT INTO project_entities (project_id, name, target_table, primary_key, rule_set_id, mapping_jsonb)
       VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (project_id, name) DO UPDATE
       SET target_table = EXCLUDED.target_table,
           primary_key  = EXCLUDED.primary_key,
           -- Preserve an already-attached rule set when the caller doesn't pass
           -- one (e.g. the Import page, which only sends a mapping). Otherwise a
           -- re-import would silently drop the entity's validation rules.
           rule_set_id  = COALESCE(EXCLUDED.rule_set_id, project_entities.rule_set_id),
           mapping_jsonb = EXCLUDED.mapping_jsonb
     RETURNING id, project_id, name, target_table, primary_key, rule_set_id, mapping_jsonb`,
    [i.projectId, i.name, i.targetTable, i.primaryKey, i.ruleSetId ?? null, JSON.stringify(i.mapping)],
  );
  return rows[0]!;
}
