import { query } from '@conductor/db';

export interface JobDefinitionRow {
  id: string;
  project_id: string;
  entity: string;
  type: string;
  name: string;
  schedule_kind: 'cron' | 'one_time' | 'recurring';
  cron: string | null;
  timezone: string;
  source_jsonb: Record<string, unknown>;
  destination_jsonb: Record<string, unknown>;
  options_jsonb: Record<string, unknown>;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
}

export interface CreateJobDefinitionInput {
  projectId: string;
  entity: string;
  type: string;
  name: string;
  scheduleKind: 'cron' | 'one_time' | 'recurring';
  cron?: string | null;
  timezone?: string;
  source?: Record<string, unknown>;
  destination?: Record<string, unknown>;
  options?: Record<string, unknown>;
  enabled?: boolean;
  nextRunAt?: Date | null;
}

export async function createJobDefinition(
  input: CreateJobDefinitionInput,
  createdBy: string | null,
): Promise<JobDefinitionRow> {
  const { rows } = await query<JobDefinitionRow>(
    `INSERT INTO job_definitions
       (project_id, entity, type, name, schedule_kind, cron, timezone,
        source_jsonb, destination_jsonb, options_jsonb, enabled, next_run_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      input.projectId,
      input.entity,
      input.type,
      input.name,
      input.scheduleKind,
      input.cron ?? null,
      input.timezone ?? 'UTC',
      JSON.stringify(input.source ?? {}),
      JSON.stringify(input.destination ?? {}),
      JSON.stringify(input.options ?? {}),
      input.enabled ?? true,
      input.nextRunAt ?? null,
      createdBy,
    ],
  );
  return rows[0]!;
}

export async function listJobDefinitions(projectId?: string): Promise<JobDefinitionRow[]> {
  const { rows } = projectId
    ? await query<JobDefinitionRow>(
        'SELECT * FROM job_definitions WHERE project_id=$1 ORDER BY created_at DESC',
        [projectId],
      )
    : await query<JobDefinitionRow>('SELECT * FROM job_definitions ORDER BY created_at DESC');
  return rows;
}

export async function getJobDefinition(id: string): Promise<JobDefinitionRow | null> {
  const { rows } = await query<JobDefinitionRow>('SELECT * FROM job_definitions WHERE id=$1', [id]);
  return rows[0] ?? null;
}

export async function setEnabled(id: string, enabled: boolean): Promise<JobDefinitionRow | null> {
  const { rows } = await query<JobDefinitionRow>(
    'UPDATE job_definitions SET enabled=$2 WHERE id=$1 RETURNING *',
    [id, enabled],
  );
  return rows[0] ?? null;
}

export async function deleteJobDefinition(id: string): Promise<boolean> {
  const { rowCount } = await query('DELETE FROM job_definitions WHERE id=$1', [id]);
  return (rowCount ?? 0) > 0;
}
