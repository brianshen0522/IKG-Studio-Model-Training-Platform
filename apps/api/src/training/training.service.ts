import { Inject, Injectable, HttpException } from '@nestjs/common';
import { DB_PROVIDER } from '../database/database.module';
import { type Kysely, type Transaction, sql } from 'kysely';
import type { Database } from '@model-trainer/db';
import { errorCode, validateYoloArgs } from '@model-trainer/shared-types';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { TrainingStateMachine } from './training-state-machine';
import { createHash, randomUUID } from 'crypto';

const DISPATCH_EVENT = 'job.training.dispatch';
const CONFIG_SCHEMA_VERSION = 1;

type Actor = { id: string; role: string };
const err = (code: string, message: string, status: number, details?: Record<string, unknown>) =>
  new HttpException({ error: { code, message, details, requestId: '' } }, status);

const FIELDS = [
  'id', 'name', 'description', 'status', 'training_dataset_id', 'base_model_id', 'hyperparameters',
  'configuration_version', 'configuration_hash', 'configuration_snapshot', 'row_version',
  'submitted_at', 'queued_at', 'preparing_at', 'started_at', 'finished_at',
  'failure_stage', 'failure_code', 'failure_message', 'result_model_id',
  'created_at', 'created_by_user_id', 'updated_at',
] as const;

/** Recorded by the wizard to rebuild its own state; not Ultralytics arguments. */
const WIZARD_ONLY_HP = new Set(['yolo_version', 'yolo_size', 'model']);

function normalizeHyperparameters(hp: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { epochs: 100, imgsz: 640, batch: 16, ...(hp ?? {}) };
  for (const k of ['epochs', 'imgsz', 'batch']) {
    const v = Number(out[k]);
    if (!Number.isFinite(v) || v <= 0) throw err(errorCode.TRAINING_INVALID_HYPERPARAMETERS, `${k} must be a positive number`, 400);
    out[k] = Math.floor(v);
  }

  // Everything else is forwarded to Ultralytics by the worker, so it is checked against
  // the same generated spec the wizard validates against. The worker re-checks with the
  // live Ultralytics; this stops a bad job being queued at all, and stops a crafted
  // request bypassing the browser.
  const checkable = Object.fromEntries(
    Object.entries(out).filter(([k]) => !WIZARD_ONLY_HP.has(k)),
  );
  const issues = validateYoloArgs(checkable);
  if (issues.length > 0) {
    const detail = issues
      .map((i) => `${i.key}: ${i.message}${i.suggestion ? ` (did you mean ${i.suggestion}?)` : ''}`)
      .join('; ');
    throw err(errorCode.TRAINING_INVALID_HYPERPARAMETERS, detail, 400, { issues });
  }
  return out;
}

@Injectable()
export class TrainingService {
  constructor(
    @Inject(DB_PROVIDER) private readonly db: Kysely<Database>,
    private readonly auditService: AuditService,
    private readonly outboxService: OutboxService,
    private readonly stateMachine: TrainingStateMachine,
  ) {}

  /**
   * Create + submit in one tx. No DRAFT state — the job enters the machine at
   * QUEUED (or BLOCKED if dependencies are not yet COMPLETED).
   */
  async create(
    input: { name: string; description?: string | null; training_dataset_id: string; base_model_id?: string | null; hyperparameters?: Record<string, unknown>; depends_on_job_ids?: string[] },
    actor: Actor,
  ) {
    const name = input.name.trim();
    if (!name || name.length > 150) throw err(errorCode.VALIDATION_FAILED, 'name must be 1-150 chars', 400);
    const hp = normalizeHyperparameters(input.hyperparameters);
    const correlationId = randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const ds = await trx.selectFrom('training_datasets as d')
        .select(['d.id', 'd.status', 'd.task_type', 'd.dataset_type_id'])
        .where('d.id', '=', input.training_dataset_id).executeTakeFirst();
      if (!ds) throw err(errorCode.TRAINING_DATASET_NOT_FOUND, 'training dataset not found', 404);
      if (ds.status !== 'READY') throw err(errorCode.TRAINING_DATASET_VERSION_NOT_READY, 'training dataset is not READY', 409);

      const baseModelId = input.base_model_id ?? null;
      if (baseModelId) {
        const bm = await trx.selectFrom('models').select(['id', 'status', 'task_type']).where('id', '=', baseModelId).executeTakeFirst();
        if (!bm) throw err(errorCode.MODEL_NOT_FOUND, 'base model not found', 404);
        if (bm.status !== 'AVAILABLE') throw err(errorCode.TRAINING_BASE_MODEL_NOT_AVAILABLE, 'base model is not AVAILABLE', 409);
        if (bm.task_type !== ds.task_type) throw err(errorCode.TRAINING_TASK_TYPE_MISMATCH, 'base model task type does not match dataset task type', 400);
      }

      const { id } = await trx.insertInto('training_jobs').values({
        name, description: input.description ?? null, status: 'QUEUED',
        training_dataset_id: input.training_dataset_id, base_model_id: baseModelId,
        hyperparameters: hp, created_by_user_id: actor.id, updated_by_user_id: actor.id,
      }).returning('id').executeTakeFirstOrThrow();

      if (input.depends_on_job_ids?.length) {
        const depIds = [...new Set(input.depends_on_job_ids)].filter((d) => d !== id);
        if (depIds.length) {
          const existing = await trx.selectFrom('training_jobs').select('id').where('id', 'in', depIds).execute();
          const found = new Set(existing.map((r) => r.id));
          const missing = depIds.find((d) => !found.has(d));
          if (missing) throw err(errorCode.TRAINING_JOB_NOT_FOUND, `dependency training job ${missing} not found`, 404);
          await trx.insertInto('training_job_dependencies')
            .values(depIds.map((dep) => ({ job_id: id, depends_on_job_id: dep, created_by_user_id: actor.id })))
            .execute();
        }
      }

      await this._dispatchInitial(trx, id, ds, hp, baseModelId, actor, correlationId, 'TRAINING_JOB_SUBMITTED');
      return trx.selectFrom('training_jobs').select(FIELDS).where('id', '=', id).executeTakeFirstOrThrow();
    });
  }

  /**
   * Clone a job and immediately submit it (no DRAFT). The new job is a fresh
   * QUEUED row pointing back at the source via cloned_from_job_id.
   */
  async clone(id: string, actor: Actor) {
    const correlationId = randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const src = await trx.selectFrom('training_jobs').selectAll().where('id', '=', id).executeTakeFirst();
      if (!src) throw err(errorCode.TRAINING_JOB_NOT_FOUND, 'training job not found', 404);
      if (!src.training_dataset_id) throw err(errorCode.VALIDATION_FAILED, 'source job has no training dataset', 400);

      const ds = await trx.selectFrom('training_datasets as d')
        .select(['d.id', 'd.status', 'd.task_type', 'd.dataset_type_id'])
        .where('d.id', '=', src.training_dataset_id).executeTakeFirst();
      if (!ds) throw err(errorCode.TRAINING_DATASET_NOT_FOUND, 'training dataset not found', 404);
      if (ds.status !== 'READY') throw err(errorCode.TRAINING_DATASET_VERSION_NOT_READY, 'training dataset is not READY', 409);
      if (src.base_model_id) {
        const bm = await trx.selectFrom('models').select(['id', 'status', 'task_type']).where('id', '=', src.base_model_id).executeTakeFirst();
        if (!bm) throw err(errorCode.MODEL_NOT_FOUND, 'base model not found', 404);
        if (bm.status !== 'AVAILABLE') throw err(errorCode.TRAINING_BASE_MODEL_NOT_AVAILABLE, 'base model is not AVAILABLE', 409);
        if (bm.task_type !== ds.task_type) throw err(errorCode.TRAINING_TASK_TYPE_MISMATCH, 'base model task type does not match dataset task type', 400);
      }

      const { id: newId } = await trx.insertInto('training_jobs').values({
        name: `${src.name} (clone)`.slice(0, 150),
        description: src.description,
        status: 'QUEUED',
        training_dataset_id: src.training_dataset_id,
        base_model_id: src.base_model_id,
        hyperparameters: src.hyperparameters as Record<string, unknown>,
        cloned_from_job_id: src.id,
        created_by_user_id: actor.id,
        updated_by_user_id: actor.id,
      }).returning('id').executeTakeFirstOrThrow();

      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id, actionCode: 'TRAINING_JOB_CLONED',
        resourceTypeCode: 'TRAINING_JOB', resourceId: newId, result: 'SUCCESS', correlationId,
        metadata: { cloned_from_job_id: src.id },
      }, trx);

      await this._dispatchInitial(trx, newId, ds, src.hyperparameters as Record<string, unknown>, src.base_model_id, actor, correlationId, 'TRAINING_JOB_SUBMITTED');
      return trx.selectFrom('training_jobs').select(FIELDS).where('id', '=', newId).executeTakeFirstOrThrow();
    });
  }

  /**
   * Initial dispatch for a freshly inserted row. Computes the configuration snapshot,
   * stamps it on the row, decides QUEUED vs BLOCKED based on dependencies, audits, and
   * (if QUEUED) creates the first job_execution + enqueues the dispatch event. The row
   * must already exist with status='QUEUED' — this method does not run it through the
   * state machine (creation is not a transition).
   */
  private async _dispatchInitial(
    trx: Transaction<Database>,
    jobId: string,
    ds: { id: string; task_type: string; dataset_type_id: string | null },
    hp: Record<string, unknown>,
    baseModelId: string | null,
    actor: Actor,
    correlationId: string,
    auditAction: string,
  ) {
    const snapshot = {
      config_schema_version: CONFIG_SCHEMA_VERSION,
      training_dataset_id: ds.id, base_model_id: baseModelId,
      task_type: ds.task_type, dataset_type_id: ds.dataset_type_id,
      hyperparameters: hp,
    };
    const configHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

    const depStatuses = await trx.selectFrom('training_job_dependencies as d')
      .innerJoin('training_jobs as dj', 'dj.id', 'd.depends_on_job_id')
      .select('dj.status')
      .where('d.job_id', '=', jobId)
      .execute();
    const allDepsCompleted = depStatuses.length === 0 || depStatuses.every((d) => d.status === 'COMPLETED');

    if (!allDepsCompleted) {
      await trx.updateTable('training_jobs').set({
        status: 'BLOCKED', submitted_at: sql`now()`,
        configuration_snapshot: snapshot as Record<string, unknown>, configuration_hash: configHash,
        updated_by_user_id: actor.id, row_version: sql`row_version + 1`, updated_at: sql`now()`,
      }).where('id', '=', jobId).execute();
      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id, actionCode: auditAction,
        resourceTypeCode: 'TRAINING_JOB', resourceId: jobId, result: 'SUCCESS', correlationId,
        metadata: { configuration_hash: configHash, dependency_count: depStatuses.length, to: 'BLOCKED' },
      }, trx);
      return;
    }

    await trx.updateTable('training_jobs').set({
      status: 'QUEUED', queued_at: sql`now()`, submitted_at: sql`now()`,
      configuration_snapshot: snapshot as Record<string, unknown>, configuration_hash: configHash,
      updated_by_user_id: actor.id, row_version: sql`row_version + 1`, updated_at: sql`now()`,
    }).where('id', '=', jobId).execute();
    await this.auditService.append({
      actorType: 'USER', actorUserId: actor.id, actionCode: auditAction,
      resourceTypeCode: 'TRAINING_JOB', resourceId: jobId, result: 'SUCCESS', correlationId,
      metadata: { configuration_hash: configHash, to: 'QUEUED' },
    }, trx);

    const assignmentToken = randomUUID();
    const { id: jobExecutionId } = await trx.insertInto('job_executions').values({
      job_type: 'TRAINING', job_id: jobId, attempt_number: 1, assignment_token: assignmentToken,
      configuration_snapshot: snapshot as Record<string, unknown>, configuration_hash: configHash,
      correlation_id: correlationId,
    }).returning('id').executeTakeFirstOrThrow();

    await this.outboxService.enqueue({
      eventType: DISPATCH_EVENT, aggregateTypeCode: 'JOB_EXECUTION', aggregateId: jobExecutionId,
      payload: {
        job_execution_id: jobExecutionId, assignment_token: assignmentToken, job_type: 'TRAINING',
        training_job_id: jobId, correlation_id: correlationId, attempt_number: 1,
      } as Record<string, unknown>,
      correlationId,
    }, trx);
  }

  private static readonly TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'STOPPED']);

  /**
   * In-place restart: same training_jobs row, new job_executions attempt. Unlike clone(),
   * this does not create a new job — the failed/stopped/cancelled attempt stays in
   * job_executions history under the same job id.
   */
  async retry(id: string, actor: Actor) {
    const correlationId = randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const job = await trx.selectFrom('training_jobs').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!job) throw err(errorCode.TRAINING_JOB_NOT_FOUND, 'training job not found', 404);
      if (!TrainingService.TERMINAL_STATUSES.has(job.status)) {
        throw err(errorCode.TRAINING_NOT_RETRYABLE, `job is ${job.status}, only terminal jobs can be retried`, 409);
      }

      if (!job.training_dataset_id) throw err(errorCode.VALIDATION_FAILED, 'training job has no training dataset', 400);
      const ds = await trx.selectFrom('training_datasets as d')
        .select(['d.id', 'd.status', 'd.task_type', 'd.dataset_type_id'])
        .where('d.id', '=', job.training_dataset_id).executeTakeFirst();
      if (!ds) throw err(errorCode.TRAINING_DATASET_NOT_FOUND, 'training dataset not found', 404);
      if (ds.status !== 'READY') throw err(errorCode.TRAINING_DATASET_VERSION_NOT_READY, 'training dataset is not READY', 409);

      if (job.base_model_id) {
        const bm = await trx.selectFrom('models').select(['id', 'status', 'task_type']).where('id', '=', job.base_model_id).executeTakeFirst();
        if (!bm) throw err(errorCode.MODEL_NOT_FOUND, 'base model not found', 404);
        if (bm.status !== 'AVAILABLE') throw err(errorCode.TRAINING_BASE_MODEL_NOT_AVAILABLE, 'base model is not AVAILABLE', 409);
        if (bm.task_type !== ds.task_type) throw err(errorCode.TRAINING_TASK_TYPE_MISMATCH, 'base model task type does not match dataset task type', 400);
      }

      const resetFields = {
        finished_at: null, cancelled_at: null, cancelled_by_user_id: null,
        stop_requested_at: null, stop_requested_by_user_id: null, stopped_at: null,
        failure_code: null, failure_message: null, failure_stage: null, result_model_id: null,
        preparing_at: null, started_at: null,
      };
      await trx.updateTable('training_jobs').set({ ...resetFields, updated_at: sql`now()`, updated_by_user_id: actor.id })
        .where('id', '=', id).execute();

      const snapshot = {
        config_schema_version: CONFIG_SCHEMA_VERSION,
        training_dataset_id: job.training_dataset_id, base_model_id: job.base_model_id,
        task_type: ds.task_type, dataset_type_id: ds.dataset_type_id,
        hyperparameters: job.hyperparameters,
      };
      const configHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

      const depStatuses = await trx.selectFrom('training_job_dependencies as d')
        .innerJoin('training_jobs as dj', 'dj.id', 'd.depends_on_job_id')
        .select('dj.status')
        .where('d.job_id', '=', id)
        .execute();
      const allDepsCompleted = depStatuses.length === 0 || depStatuses.every((d) => d.status === 'COMPLETED');

      const { attempt_number: lastAttempt } = await trx.selectFrom('job_executions')
        .select('attempt_number').where('job_type', '=', 'TRAINING').where('job_id', '=', id)
        .orderBy('attempt_number', 'desc').limit(1).executeTakeFirstOrThrow();
      const nextAttempt = lastAttempt + 1;

      if (!allDepsCompleted) {
        await this.stateMachine.transition(trx, {
          jobId: id, to: 'BLOCKED', actorType: 'USER', actorUserId: actor.id, correlationId,
          auditAction: 'TRAINING_JOB_RETRIED',
          extraSet: {
            submitted_at: sql`now()`,
            configuration_snapshot: snapshot as Record<string, unknown>, configuration_hash: configHash,
            updated_by_user_id: actor.id,
          },
          metadata: { configuration_hash: configHash, dependency_count: depStatuses.length },
        });
        return trx.selectFrom('training_jobs').select(FIELDS).where('id', '=', id).executeTakeFirstOrThrow();
      }

      await this.stateMachine.transition(trx, {
        jobId: id, to: 'QUEUED', actorType: 'USER', actorUserId: actor.id, correlationId,
        auditAction: 'TRAINING_JOB_RETRIED',
        extraSet: {
          submitted_at: sql`now()`,
          configuration_snapshot: snapshot as Record<string, unknown>, configuration_hash: configHash,
          updated_by_user_id: actor.id,
        },
        metadata: { configuration_hash: configHash },
      });

      const assignmentToken = randomUUID();
      const { id: jobExecutionId } = await trx.insertInto('job_executions').values({
        job_type: 'TRAINING', job_id: id, attempt_number: nextAttempt, assignment_token: assignmentToken,
        configuration_snapshot: snapshot as Record<string, unknown>, configuration_hash: configHash,
        correlation_id: correlationId,
      }).returning('id').executeTakeFirstOrThrow();

      await this.outboxService.enqueue({
        eventType: DISPATCH_EVENT, aggregateTypeCode: 'JOB_EXECUTION', aggregateId: jobExecutionId,
        payload: {
          job_execution_id: jobExecutionId, assignment_token: assignmentToken, job_type: 'TRAINING',
          training_job_id: id, correlation_id: correlationId, attempt_number: nextAttempt,
        } as Record<string, unknown>,
        correlationId,
      }, trx);

      return trx.selectFrom('training_jobs').select(FIELDS).where('id', '=', id).executeTakeFirstOrThrow();
    });
  }

  async requestStop(id: string, actor: Actor) {
    const correlationId = randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const job = await trx.selectFrom('training_jobs').select(['id', 'status']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!job) throw err(errorCode.TRAINING_JOB_NOT_FOUND, 'training job not found', 404);
      if (job.status === 'RUNNING') {
        await this.stateMachine.transition(trx, {
          jobId: id, to: 'STOPPING', actorType: 'USER', actorUserId: actor.id, correlationId,
          auditAction: 'TRAINING_JOB_STOP_REQUESTED', extraSet: { stop_requested_by_user_id: actor.id },
        });
        return { id, status: 'STOPPING' };
      }
      if (job.status === 'QUEUED' || job.status === 'PREPARING' || job.status === 'SCHEDULED' || job.status === 'BLOCKED') {
        await this.stateMachine.transition(trx, {
          jobId: id, to: 'CANCELLED', actorType: 'USER', actorUserId: actor.id, correlationId,
          auditAction: 'TRAINING_JOB_CANCELLED', extraSet: { cancelled_by_user_id: actor.id },
        });
        return { id, status: 'CANCELLED' };
      }
      throw err(errorCode.TRAINING_NOT_STOPPABLE, `job in ${job.status} cannot be stopped/cancelled`, 409);
    });
  }

  async get(id: string) {
    const row = await this.db.selectFrom('training_jobs').select(FIELDS).where('id', '=', id).executeTakeFirst();
    if (!row) throw err(errorCode.TRAINING_JOB_NOT_FOUND, 'training job not found', 404);
    const executions = await this.db.selectFrom('job_executions')
      .select(['id', 'attempt_number', 'status', 'started_at', 'finished_at', 'error_code', 'progress_percent'])
      .where('job_type', '=', 'TRAINING').where('job_id', '=', id).orderBy('attempt_number', 'desc').execute();
    return { ...row, executions };
  }

  async list(params: { page: number; size: number; status?: string; training_dataset_id?: string }) {
    const size = Math.min(Math.max(params.size, 1), 200);
    const offset = (params.page - 1) * size;
    let q = this.db.selectFrom('training_jobs');
    if (params.status) q = q.where('status', '=', params.status as never);
    if (params.training_dataset_id) q = q.where('training_dataset_id', '=', params.training_dataset_id);
    const [{ count }] = await q.select(sql<number>`count(*)`.as('count')).execute();
    const rows = await q.select([
      'id', 'name', 'status', 'training_dataset_id', 'base_model_id', 'result_model_id',
      'created_by_user_id', 'created_at', 'submitted_at', 'finished_at',
    ]).orderBy('created_at', 'desc').limit(size).offset(offset).execute();

    const modelIds = rows.map((r) => r.base_model_id).filter(Boolean) as string[];
    const datasetIds = rows.map((r) => r.training_dataset_id).filter(Boolean) as string[];

    const modelRows = modelIds.length > 0
      ? await this.db.selectFrom('models').select(['id', 'name']).where('id', 'in', modelIds).execute()
      : [];
    const datasetRows = datasetIds.length > 0
      ? await this.db.selectFrom('training_datasets').select(['id', 'name', 'dataset_type_id']).where('id', 'in', datasetIds).execute()
      : [];
    const typeIds = [...new Set(datasetRows.map((d) => d.dataset_type_id).filter(Boolean))] as string[];
    const typeRows = typeIds.length > 0
      ? await this.db.selectFrom('dataset_types').select(['id', 'name']).where('id', 'in', typeIds).execute()
      : [];
    const typeMap = new Map(typeRows.map((t) => [t.id, t.name]));
    const modelMap = new Map(modelRows.map((m) => [m.id, m.name]));
    const datasetMap = new Map(datasetRows.map((d) => [d.id, d]));

    const items = rows.map((r) => {
      const ds = r.training_dataset_id ? datasetMap.get(r.training_dataset_id) : undefined;
      return {
        ...r,
        model_name: r.base_model_id ? (modelMap.get(r.base_model_id) ?? null) : null,
        training_dataset_name: ds?.name ?? null,
        dataset_type_id: ds?.dataset_type_id ?? null,
        dataset_type_name: ds?.dataset_type_id ? (typeMap.get(ds.dataset_type_id) ?? null) : null,
      };
    });

    return { items, total: Number(count), page: params.page, size };
  }
}
