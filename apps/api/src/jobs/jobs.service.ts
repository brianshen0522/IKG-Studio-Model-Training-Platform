import { Inject, Injectable, HttpException } from '@nestjs/common';
import { DB_PROVIDER } from '../database/database.module';
import { type Kysely, sql } from 'kysely';
import type { Database } from '@model-trainer/db';
import { errorCode } from '@model-trainer/shared-types';

const err = (code: string, message: string, status: number) =>
  new HttpException({ error: { code, message, requestId: '' } }, status);

export interface JobItem {
  id: string;
  job_type: string;
  name: string;
  business_status: string | null;
  execution_status: string;
  progress_percent: string;
  progress_message: string | null;
  task_type: string | null;
  resource_id: string;
  worker_id: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export const JOB_TYPE_LABEL: Record<string, string> = {
  TRAINING: 'Training',
  DATASET_BUILD: 'Dataset Build',
  TRAINING_DATASET_SCAN: 'Dataset Validate',
  DATASET_SCAN: 'Dataset Scan',
  BENCHMARK_EVALUATION: 'Benchmark Eval',
  MODEL_INGEST: 'Model Ingest',
  MODEL_CONVERSION: 'Model Conversion',
};

const ACTIVE_EXEC_STATUS: string[] = ['ASSIGNED', 'CLAIMED', 'PREPARING', 'RUNNING'];

// Each query fetches all rows from a job type; filtering/pagination happens in-memory.
// The total volume is bounded by the total job_executions in the system (typically <10k).
async function fetchType(db: Kysely<Database>, query: string): Promise<JobItem[]> {
  const res = await sql.raw(query).execute(db);
  return res.rows as JobItem[];
}

const TRAINING_Q = `SELECT je.id::text, 'TRAINING'::text AS job_type,
  tj.name::text AS name, tj.status::text AS business_status,
  je.status::text AS execution_status, je.progress_percent::text AS progress_percent,
  je.progress_message::text, NULL::text AS task_type,
  tj.id::text AS resource_id, je.worker_id::text, je.error_message::text,
  je.started_at::text, je.finished_at::text, je.created_at::text
FROM app.job_executions je JOIN app.training_jobs tj ON je.job_id = tj.id
WHERE je.job_type = 'TRAINING'`;

// Covers both dataset job types: DATASET_BUILD (origin=BUILT) and TRAINING_DATASET_SCAN
// (origin=REGISTERED). Both hang off app.training_datasets since migration 055.
const BUILD_Q = `SELECT je.id::text, je.job_type::text AS job_type,
  (CASE WHEN je.job_type = 'TRAINING_DATASET_SCAN' THEN 'Validate: ' ELSE 'Build: ' END || d.name)::text AS name,
  d.status::text AS business_status, je.status::text AS execution_status, je.progress_percent::text,
  je.progress_message::text, d.task_type::text,
  d.id::text AS resource_id, je.worker_id::text, je.error_message::text,
  je.started_at::text, je.finished_at::text, je.created_at::text
FROM app.job_executions je
JOIN app.training_datasets d ON je.job_id = d.id
WHERE je.job_type IN ('DATASET_BUILD', 'TRAINING_DATASET_SCAN')`;

const SCAN_Q = `SELECT je.id::text, 'DATASET_SCAN'::text AS job_type,
  ('Scan: ' || sd.name)::text AS name, sc.status::text AS business_status,
  je.status::text AS execution_status, je.progress_percent::text, je.progress_message::text,
  sd.task_type::text, sc.id::text AS resource_id, je.worker_id::text, je.error_message::text,
  je.started_at::text, je.finished_at::text, je.created_at::text
FROM app.job_executions je
JOIN app.source_dataset_scans sc ON je.job_id = sc.id
JOIN app.source_datasets sd ON sc.source_dataset_id = sd.id
WHERE je.job_type = 'DATASET_SCAN'`;

const BENCH_Q = `SELECT je.id::text, 'BENCHMARK_EVALUATION'::text AS job_type,
  ('Eval: ' || m.name || ' on ' || br.name)::text AS name, be.status::text AS business_status,
  je.status::text AS execution_status, je.progress_percent::text, je.progress_message::text,
  m.task_type::text, be.id::text AS resource_id, je.worker_id::text, je.error_message::text,
  je.started_at::text, je.finished_at::text, je.created_at::text
FROM app.job_executions je
JOIN app.benchmark_evaluations be ON je.job_id = be.id
JOIN app.benchmark_runs br ON be.benchmark_run_id = br.id
JOIN app.models m ON be.model_id = m.id
WHERE je.job_type = 'BENCHMARK_EVALUATION'`;

const INGEST_Q = `SELECT je.id::text, 'MODEL_INGEST'::text AS job_type,
  ('Ingest: ' || mit.requested_name)::text AS name, mit.status::text AS business_status,
  je.status::text AS execution_status, je.progress_percent::text, je.progress_message::text,
  NULL::text AS task_type, mit.id::text AS resource_id, je.worker_id::text, je.error_message::text,
  je.started_at::text, je.finished_at::text, je.created_at::text
FROM app.job_executions je
JOIN app.model_ingest_tasks mit ON je.job_id = mit.id
WHERE je.job_type = 'MODEL_INGEST'`;

const CONVERSION_Q = `SELECT je.id::text, 'MODEL_CONVERSION'::text AS job_type,
  ('Convert: ' || m.name)::text AS name, mc.status::text AS business_status,
  je.status::text AS execution_status, je.progress_percent::text, je.progress_message::text,
  m.task_type::text, mc.id::text AS resource_id, je.worker_id::text, je.error_message::text,
  je.started_at::text, je.finished_at::text, je.created_at::text
FROM app.job_executions je
JOIN app.model_conversions mc ON je.job_id = mc.id
JOIN app.models m ON mc.model_id = m.id
WHERE je.job_type = 'MODEL_CONVERSION'`;

const ALL_QUERIES: { type: string; sql: string }[] = [
  { type: 'TRAINING', sql: TRAINING_Q },
  { type: 'DATASET_BUILD', sql: BUILD_Q },
  { type: 'DATASET_SCAN', sql: SCAN_Q },
  { type: 'BENCHMARK_EVALUATION', sql: BENCH_Q },
  { type: 'MODEL_INGEST', sql: INGEST_Q },
  { type: 'MODEL_CONVERSION', sql: CONVERSION_Q },
];

function matches(item: JobItem, params: {
  jobType?: string; execStatus?: string; businessStatus?: string; active?: boolean;
}): boolean {
  if (params.jobType && item.job_type !== params.jobType) return false;
  if (params.execStatus && item.execution_status !== params.execStatus) return false;
  if (params.businessStatus && item.business_status !== params.businessStatus) return false;
  if (params.active && !ACTIVE_EXEC_STATUS.includes(item.execution_status)) return false;
  return true;
}

@Injectable()
export class JobsService {
  constructor(@Inject(DB_PROVIDER) private readonly db: Kysely<Database>) {}

  async getById(id: string): Promise<JobItem> {
    const all = await Promise.all(ALL_QUERIES.map((q) => fetchType(this.db, q.sql)));
    const item = all.flat().find((i) => i.id === id);
    if (!item) throw err(errorCode.RESOURCE_NOT_FOUND, 'job not found', 404);
    return item;
  }

  async list(params: {
    jobType?: string; execStatus?: string; businessStatus?: string;
    active?: boolean; page: number; size: number;
  }): Promise<{ items: JobItem[]; total: number }> {
    // Fetch only the queried type (or all types)
    const queries = params.jobType
      ? ALL_QUERIES.filter((q) => q.type === params.jobType)
      : ALL_QUERIES;

    const results = await Promise.all(queries.map((q) => fetchType(this.db, q.sql)));
    const all = results.flat().filter((item) => matches(item, params));
    all.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

    const size = Math.min(Math.max(params.size, 1), 100);
    const offset = (params.page - 1) * size;
    return { items: all.slice(offset, offset + size), total: all.length };
  }
}
