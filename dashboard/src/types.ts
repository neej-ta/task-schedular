export type Role = 'admin' | 'operator' | 'viewer';
export type Provider = 'postgres' | 'sqlserver' | 'mysql';

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  environment: 'prod' | 'test';
  status: 'active' | 'disabled';
  provider: Provider;
  host: string;
  port: number;
  database: string;
  schema: string | null;
  username: string;
  secretMasked: string;
  ssl_mode: string;
  pool_max: number;
  query_timeout_s: number;
  max_rows: number;
  concurrency_limit: number;
  allowlist_hosts: string[];
  isolation_mode: 'shared' | 'dedicated';
  db_schema: string | null;
  container_state: 'none' | 'provisioning' | 'running' | 'stopping' | 'stopped' | 'error';
  created_at: string;
}

export interface TestConnectionResult {
  ok: boolean;
  latencyMs: number;
  serverVersion?: string;
  error?: string;
}

export type JobType =
  | 'bulk_import'
  | 'bulk_insert'
  | 'bulk_update'
  | 'bulk_delete'
  | 'file_inbound'
  | 'file_outbound'
  | 'xml_integration'
  | 'rest_pull'
  | 'rest_push'
  | 'webhook';

export interface JobDefinition {
  id: string;
  project_id: string;
  entity: string;
  type: JobType;
  name: string;
  schedule_kind: 'cron' | 'one_time' | 'recurring';
  cron: string | null;
  timezone: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
}

export interface Job {
  id: string;
  project_id: string;
  entity: string;
  type: JobType;
  status: string;
  priority: number;
  attempt: number;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  worker_id: string | null;
  error_summary: string | null;
  parameters_jsonb?: Record<string, unknown>;
  source_jsonb?: Record<string, unknown>;
  destination_jsonb?: Record<string, unknown>;
  idempotency_key?: string | null;
}

export interface JobLog {
  id: number;
  ts: string;
  level: string;
  message: string;
  chunk_index: number | null;
}
export interface JobChunk {
  chunk_index: number;
  status: string;
  processed_count: number;
  row_start: number;
  row_end: number;
}
export interface JobErrorRow {
  row_number: number;
  field: string | null;
  rule: string;
  message: string;
  raw?: Record<string, unknown> | null;
}
export interface JobEventRow {
  ts: string;
  type: string;
  actor: string | null;
  message: string;
}
export interface Progress {
  processed: number;
  total: number;
  errors: number;
  chunksRemaining: number;
  status: string;
}
export interface ActivityEvent {
  ts: string;
  type: string;
  jobId?: string | null;
  projectId?: string | null;
  actor?: string | null;
  message: string;
}
