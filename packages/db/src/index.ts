import { Kysely, PostgresDialect, type Generated } from 'kysely';
import { Pool, types } from 'pg';
import type { PoolConfig } from 'pg';

// Return TIMESTAMP/TIMESTAMPTZ as raw strings (matches the Generated<string> column
// types below); the pg default of JS Date loses precision and breaks string equality.
types.setTypeParser(1114, (v) => v); // timestamp
types.setTypeParser(1184, (v) => v); // timestamptz

// ── Enums ──
export type AuditActorType = 'USER' | 'WORKER' | 'SCHEDULER' | 'SYSTEM' | 'API';
export type AuditResult = 'SUCCESS' | 'FAILURE';
export type NotificationSeverity = 'SUCCESS' | 'WARNING' | 'ERROR';
export type OutboxStatus = 'PENDING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED' | 'DEAD';
export type UserRole = 'ADMIN' | 'USER';
export type UserStatus = 'ACTIVE' | 'DISABLED' | 'LOCKED';
export type WorkerType = 'TRAINING' | 'BENCHMARK' | 'DATASET' | 'CLEANUP' | 'GENERAL';
export type WorkerStatus = 'ONLINE' | 'IDLE' | 'BUSY' | 'DRAINING' | 'OFFLINE' | 'ERROR';

export interface WorkersTable {
  id: Generated<string>;
  worker_key: string;
  worker_type: WorkerType;
  hostname: string;
  status: WorkerStatus;
  capabilities: Generated<Record<string, unknown>>;
  worker_version: Generated<string>;
  container_image: string | null;
  python_version: string | null;
  torch_version: string | null;
  ultralytics_version: string | null;
  cuda_version: string | null;
  active_job_count: Generated<number>;
  last_heartbeat_at: string | null;
  registered_at: Generated<string>;
  updated_at: Generated<string>;
  disabled_at: string | null;
}

export interface WorkerGpusTable {
  id: Generated<string>;
  worker_id: string;
  gpu_uuid: string;
  gpu_index: number;
  name: string;
  memory_total_bytes: number;
  enabled: Generated<boolean>;
  last_seen_at: Generated<string>;
}

// ── Table Interfaces ──
export interface UsersTable {
  id: Generated<string>;
  username: string;
  display_name: string;
  email: string | null;
  password_hash: string;
  role: UserRole;
  status: UserStatus;
  failed_login_count: Generated<number>;
  locked_until: string | null;
  last_login_at: string | null;
  password_updated_at: Generated<string>;
  created_at: Generated<string>;
  created_by_user_id: string | null;
  updated_at: Generated<string>;
  updated_by_user_id: string | null;
  disabled_at: string | null;
  disabled_by_user_id: string | null;
  must_change_password: Generated<boolean>;
  row_version: Generated<number>;
}

export interface UserSessionsTable {
  id: Generated<string>;
  user_id: string;
  session_token_hash: string;
  created_at: Generated<string>;
  last_seen_at: Generated<string>;
  idle_expires_at: string;
  absolute_expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_password_version: string;
}

export interface ResourceTypesTable {
  code: string;
  display_name: string;
  supports_artifacts: boolean;
  supports_audit: boolean;
  supports_notification: boolean;
  enabled: boolean;
  created_at: Generated<string>;
}

export interface ArtifactTypesTable {
  code: string;
  display_name: string;
  category: string;
  allowed_owner_type_code: string | null;
  mime_type_pattern: string | null;
  supports_preview: Generated<boolean>;
  sort_order: Generated<number>;
  enabled: Generated<boolean>;
  created_at: Generated<string>;
}

export interface AuditLogsTable {
  id: Generated<number>;
  occurred_at: Generated<string>;
  actor_type: AuditActorType;
  actor_user_id: string | null;
  actor_ref: string | null;
  action_code: string;
  resource_type_code: string;
  resource_id: string;
  result: AuditResult;
  correlation_id: Generated<string>;
  parent_audit_id: number | null;
  before_snapshot: Record<string, unknown> | null;
  after_snapshot: Record<string, unknown> | null;
  diff: Record<string, unknown> | null;
  metadata: Generated<Record<string, unknown>>;
  error_code: string | null;
  error_message: string | null;
  request_id: string | null;
  trace_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
}

export interface AuditRelatedResourcesTable {
  audit_log_id: number;
  resource_type_code: string;
  resource_id: string;
  relation_code: string | null;
}

export interface NotificationsTable {
  id: Generated<string>;
  audit_log_id: number;
  recipient_user_id: string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  resource_type_code: string;
  resource_id: string;
  created_at: Generated<string>;
  read_at: string | null;
  archived_at: string | null;
}

export interface OutboxEventsTable {
  id: Generated<string>;
  event_type: string;
  aggregate_type_code: string;
  aggregate_id: string;
  payload: Generated<Record<string, unknown>>;
  correlation_id: Generated<string>;
  status: Generated<OutboxStatus>;
  available_at: Generated<string>;
  attempt_count: Generated<number>;
  locked_at: string | null;
  locked_by: string | null;
  published_at: string | null;
  last_error: string | null;
  created_at: Generated<string>;
}

export interface SystemSettingsTable {
  setting_key: string;
  value: Record<string, unknown>;
  value_schema_version: Generated<number>;
  description: string | null;
  is_secret: Generated<boolean>;
  updated_at: Generated<string>;
  updated_by_user_id: string | null;
  row_version: Generated<number>;
}

export interface DatasetTypesTable {
  id: Generated<string>;
  name: string;
  parent_id: string | null;
  description: string | null;
  icon: string | null;
  color: string | null;
  dataset_path: string;
  model_path: string;
  training_dataset_path: string | null;
  sort_order: number;
  enabled: Generated<boolean>;
  is_system: Generated<boolean>;
  created_at: Generated<string>;
  created_by_user_id: string | null;
  updated_at: Generated<string>;
  updated_by_user_id: string | null;
  row_version: Generated<number>;
}

export interface IdempotencyKeysTable {
  idempotency_key: string;
  user_id: string;
  operation_code: string;
  request_hash: string;
  resource_type_code: string | null;
  resource_id: string | null;
  response_status: number | null;
  response_body: Record<string, unknown> | null;
  created_at: Generated<string>;
  expires_at: string;
}

export type DatasetTaskType = 'DETECT' | 'OBB' | 'SEGMENT' | 'POSE' | 'CLASSIFY';
export type SourceDatasetStatus = 'REGISTERED' | 'SCANNING' | 'READY' | 'INVALID' | 'ARCHIVED';
export type DatasetScanStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type JobType =
  | 'TRAINING' | 'BENCHMARK_EVALUATION' | 'DATASET_BUILD' | 'DATASET_SCAN' | 'TRAINING_DATASET_SCAN'
  | 'MODEL_INGEST' | 'MODEL_CONVERSION' | 'MODEL_DELETE' | 'CLEANUP' | 'MAINTENANCE';
export type ModelConversionStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export type JobExecutionStatus =
  | 'ASSIGNED' | 'CLAIMED' | 'PREPARING' | 'RUNNING' | 'SUCCEEDED'
  | 'FAILED' | 'CANCELLED' | 'STOPPED' | 'LOST';
export type ArtifactStatus =
  | 'PENDING' | 'UPLOADING' | 'STORED' | 'VERIFYING' | 'VERIFIED' | 'FAILED' | 'ARCHIVED';

export interface SourceDatasetsTable {
  id: Generated<string>;
  name: string;
  dataset_type_id: string;
  task_type: DatasetTaskType;
  relative_path: string;
  sub_path: string | null;
  allow_subdirectories: boolean;
  status: SourceDatasetStatus;
  latest_scan_id: string | null;
  event_version: Generated<number>;
  images_relative_path: Generated<string>;
  labels_relative_path: Generated<string>;
  classes_file_relative_path: string | null;
  split_layout: Generated<Record<string, unknown>>;
  notes: string | null;
  row_version: Generated<number>;
  created_at: Generated<string>;
  created_by_user_id: string | null;
  updated_at: Generated<string>;
  updated_by_user_id: string | null;
  archived_at: string | null;
  archived_by_user_id: string | null;
  manual_classes_override: string[] | null;
}

/** One discovered dataset folder (images/ + labels/) under a type's dataset_path. */
export interface DatasetDirectoryIndexTable {
  dataset_type_id: string;
  sub_path: string;
  image_count: Generated<number>;
  label_count: Generated<number>;
  discovered_at: Generated<string>;
}

/** Per-type reindex job status; PK = dataset_type_id so at most one is in flight. */
export interface DatasetTypeReindexesTable {
  dataset_type_id: string;
  status: string;
  correlation_id: string;
  started_at: Generated<string>;
  heartbeat_at: string | null;
  finished_at: string | null;
  error_message: string | null;
}

export interface SourceDatasetScansTable {
  id: Generated<string>;
  source_dataset_id: string;
  status: DatasetScanStatus;
  scan_version: number;
  started_at: string | null;
  finished_at: string | null;
  image_count: Generated<number>;
  label_count: Generated<number>;
  matched_pair_count: Generated<number>;
  missing_image_count: Generated<number>;
  missing_label_count: Generated<number>;
  invalid_label_count: Generated<number>;
  ignored_file_count: Generated<number>;
  empty_label_count: Generated<number>;
  warning_count: Generated<number>;
  error_count: Generated<number>;
  class_count: Generated<number>;
  classes_hash: string | null;
  classes_source: string | null;
  content_hash: string | null;
  manifest_artifact_id: string | null;
  summary: Generated<Record<string, unknown>>;
  error_code: string | null;
  error_message: string | null;
  created_at: Generated<string>;
  created_by_user_id: string | null;
}

export interface SourceDatasetClassesTable {
  id: Generated<string>;
  scan_id: string;
  class_index: number;
  class_name: string;
  source: string;
  object_count: Generated<number>;
}

export interface SourceDatasetScanIssuesTable {
  id: Generated<string>;
  scan_id: string;
  severity: string;
  issue_code: string;
  image_relative_path: string | null;
  label_relative_path: string | null;
  line_number: number | null;
  details: Generated<Record<string, unknown>>;
  created_at: Generated<string>;
}

export interface JobExecutionsTable {
  id: Generated<string>;
  job_type: JobType;
  job_id: string;
  attempt_number: Generated<number>;
  status: Generated<JobExecutionStatus>;
  worker_id: string | null;
  assignment_token: Generated<string>;
  queue_message_id: string | null;
  configuration_snapshot: Generated<Record<string, unknown>>;
  configuration_hash: Generated<string>;
  runtime_metadata: Generated<Record<string, unknown>>;
  progress_percent: Generated<string>;
  progress_message: string | null;
  assigned_at: Generated<string>;
  claimed_at: string | null;
  started_at: string | null;
  heartbeat_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  error_code: string | null;
  error_message: string | null;
  correlation_id: Generated<string>;
  created_at: Generated<string>;
}

export interface ArtifactsTable {
  id: Generated<string>;
  owner_type_code: string;
  owner_id: string;
  artifact_type_code: string;
  source_execution_id: string | null;
  status: Generated<ArtifactStatus>;
  bucket_name: string;
  object_key: string;
  filename: string;
  extension: string | null;
  mime_type: string;
  file_size_bytes: number;
  checksum_algorithm: Generated<string>;
  checksum: string;
  is_primary: Generated<boolean>;
  metadata: Generated<Record<string, unknown>>;
  created_at: Generated<string>;
  created_by_actor_type: AuditActorType;
  created_by_actor_ref: string | null;
  verified_at: string | null;
  archived_at: string | null;
}

/** How a training dataset came to exist (migration 055). */
export type TrainingDatasetOrigin = 'BUILT' | 'REGISTERED';

export interface TrainingDatasetsTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  dataset_type_id: string;
  task_type: DatasetTaskType;
  origin: Generated<TrainingDatasetOrigin>;
  status: Generated<string>;
  source_dataset_ids: unknown | null;
  version_number: Generated<number>;
  split_strategy: string | null;
  random_seed: number | null;
  train_ratio: number | null;
  val_ratio: number | null;
  test_ratio: number | null;
  storage_mode: string | null;
  train_count: Generated<number>;
  val_count: Generated<number>;
  test_count: Generated<number>;
  class_count: Generated<number>;
  classes_hash: Generated<string>;
  configuration_hash: Generated<string>;
  data_yaml_artifact_id: string | null;
  manifest_artifact_id: string | null;
  build_job_id: string | null;
  relative_path: string | null;
  failure_code: string | null;
  failure_message: string | null;
  build_started_at: string | null;
  build_finished_at: string | null;
  ready_at: string | null;
  same_split_targets: unknown | null;
  row_version: Generated<number>;
  created_at: Generated<string>;
  created_by_user_id: string | null;
  updated_at: Generated<string>;
  updated_by_user_id: string | null;
  archived_at: string | null;
}

export type ModelSourceType = 'UPLOAD' | 'URL_DOWNLOAD' | 'TRAINING';
export type ModelStatus = 'PENDING' | 'AVAILABLE' | 'INVALID' | 'FAILED' | 'ARCHIVED' | 'DELETED';

export interface ModelsTable {
  id: Generated<string>;
  name: string;
  version_label: string | null;
  description: string | null;
  dataset_type_id: string;
  task_type: DatasetTaskType;
  source_type: ModelSourceType;
  status: Generated<ModelStatus>;
  model_path: string | null;
  relative_path: string;
  original_filename: string;
  file_size_bytes: number;
  checksum_algorithm: Generated<string>;
  checksum: string;
  source_url: string | null;
  source_artifact_id: string | null;
  source_training_job_id: string | null;
  architecture_metadata: Generated<Record<string, unknown>>;
  runtime_metadata: Generated<Record<string, unknown>>;
  validation_summary: Generated<Record<string, unknown>>;
  row_version: Generated<number>;
  created_at: Generated<string>;
  created_by_user_id: string | null;
  available_at: string | null;
  archived_at: string | null;
  archived_by_user_id: string | null;
}

export interface ModelConversionsTable {
  id: Generated<string>;
  model_id: string;
  status: Generated<ModelConversionStatus>;
  args: Generated<Record<string, unknown>>;
  artifact_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  requested_by_user_id: string | null;
  created_at: Generated<string>;
  started_at: string | null;
  finished_at: string | null;
  row_version: Generated<number>;
}

export interface ModelIngestTasksTable {
  id: Generated<string>;
  source_type: ModelSourceType;
  status: Generated<string>;
  requested_name: string;
  requested_version_label: string | null;
  requested_description: string | null;
  dataset_type_id: string;
  task_type: DatasetTaskType;
  original_filename: string | null;
  source_url: string | null;
  expected_checksum: string | null;
  expected_size_bytes: number | null;
  temporary_object_key: string | null;
  progress_percent: Generated<number>;
  progress_message: string | null;
  result_model_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  correlation_id: Generated<string>;
  created_at: Generated<string>;
  created_by_user_id: string;
  started_at: string | null;
  finished_at: string | null;
}

export type TrainingJobStatus =
  | 'SCHEDULED' | 'QUEUED' | 'PREPARING' | 'RUNNING' | 'STOPPING'
  | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'STOPPED' | 'BLOCKED';

export interface TrainingJobsTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  status: Generated<TrainingJobStatus>;
  training_dataset_id: string | null;
  base_model_id: string | null;
  hyperparameters: Generated<Record<string, unknown>>;
  configuration_version: Generated<number>;
  configuration_hash: Generated<string>;
  configuration_snapshot: Generated<Record<string, unknown>>;
  row_version: Generated<number>;
  scheduled_at: string | null;
  submitted_at: string | null;
  queued_at: string | null;
  preparing_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  locked_at: string | null;
  cancelled_at: string | null;
  cancelled_by_user_id: string | null;
  stop_requested_at: string | null;
  stop_requested_by_user_id: string | null;
  stopped_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
  failure_stage: string | null;
  result_model_id: string | null;
  parent_job_id: string | null;
  resume_source_job_id: string | null;
  cloned_from_job_id: string | null;
  experiment_id: string | null;
  job_group_id: string | null;
  created_at: Generated<string>;
  created_by_user_id: string;
  updated_at: Generated<string>;
  updated_by_user_id: string | null;
}

export interface TrainingJobDependenciesTable {
  id: Generated<string>;
  job_id: string;
  depends_on_job_id: string;
  created_at: Generated<string>;
  created_by_user_id: string;
}

export type BenchmarkRunStatus =
  | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'PARTIALLY_FAILED' | 'FAILED' | 'CANCELLED' | 'STOPPING' | 'STOPPED';
export type BenchmarkEvaluationStatus =
  | 'PENDING' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'STOPPING' | 'STOPPED';

export interface BenchmarkRunsTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  status: Generated<BenchmarkRunStatus>;
  evaluation_count: Generated<number>;
  completed_count: Generated<number>;
  failed_count: Generated<number>;
  queued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  stop_requested_at: string | null;
  stop_requested_by_user_id: string | null;
  stopped_at: string | null;
  cloned_from_run_id: string | null;
  created_at: Generated<string>;
  created_by_user_id: string;
  updated_at: Generated<string>;
}

export interface BenchmarkRunModelsTable {
  benchmark_run_id: string;
  model_id: string;
  model_checksum_snapshot: Generated<string>;
  sort_order: Generated<number>;
}

export interface BenchmarkRunDatasetsTable {
  benchmark_run_id: string;
  training_dataset_id: string;
  dataset_configuration_hash: Generated<string>;
  sort_order: Generated<number>;
}

export interface BenchmarkEvaluationsTable {
  id: Generated<string>;
  benchmark_run_id: string;
  model_id: string;
  training_dataset_id: string;
  status: Generated<BenchmarkEvaluationStatus>;
  map50: number | null;
  map50_95: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  metrics: Generated<Record<string, unknown>>;
  started_at: string | null;
  finished_at: string | null;
  stopped_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: Generated<string>;
}

export interface WebauthnCredentialsTable {
  id: Generated<string>;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: Generated<number>;
  transports: Generated<unknown>;
  device_type: string | null;
  backed_up: Generated<boolean>;
  name: string;
  aaguid: string | null;
  created_at: Generated<string>;
  last_used_at: string | null;
}

export interface WebauthnChallengesTable {
  id: Generated<string>;
  challenge: string;
  flow_type: string;
  user_id: string | null;
  created_at: Generated<string>;
  expires_at: string;
}

// ── Augmented Database ──
export interface Database {
  users: UsersTable;
  user_sessions: UserSessionsTable;
  resource_types: ResourceTypesTable;
  artifact_types: ArtifactTypesTable;
  audit_logs: AuditLogsTable;
  audit_related_resources: AuditRelatedResourcesTable;
  notifications: NotificationsTable;
  outbox_events: OutboxEventsTable;
  system_settings: SystemSettingsTable;
  dataset_types: DatasetTypesTable;
  training_datasets: TrainingDatasetsTable;
  idempotency_keys: IdempotencyKeysTable;
  source_datasets: SourceDatasetsTable;
  dataset_directory_index: DatasetDirectoryIndexTable;
  dataset_type_reindexes: DatasetTypeReindexesTable;
  source_dataset_scans: SourceDatasetScansTable;
  source_dataset_classes: SourceDatasetClassesTable;
  source_dataset_scan_issues: SourceDatasetScanIssuesTable;
  job_executions: JobExecutionsTable;
  artifacts: ArtifactsTable;
  models: ModelsTable;
  model_ingest_tasks: ModelIngestTasksTable;
  model_conversions: ModelConversionsTable;
  training_jobs: TrainingJobsTable;
  training_job_dependencies: TrainingJobDependenciesTable;
  benchmark_runs: BenchmarkRunsTable;
  benchmark_run_models: BenchmarkRunModelsTable;
  benchmark_run_datasets: BenchmarkRunDatasetsTable;
  benchmark_evaluations: BenchmarkEvaluationsTable;
  webauthn_credentials: WebauthnCredentialsTable;
  webauthn_challenges: WebauthnChallengesTable;
  workers: WorkersTable;
  worker_gpus: WorkerGpusTable;
}

export function createDb(config: PoolConfig) {
  const pool = new Pool({ ...config, options: '-c search_path=app,public' });
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
  return { db, pool };
}

export type DbInstance = ReturnType<typeof createDb>;

export { Kysely, PostgresDialect, Pool };
export type { PoolConfig };
