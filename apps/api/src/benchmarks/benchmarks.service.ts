import { Inject, Injectable, HttpException } from '@nestjs/common';
import { DB_PROVIDER } from '../database/database.module';
import { type Kysely, type Transaction, sql } from 'kysely';
import type { Database } from '@model-trainer/db';
import { errorCode } from '@model-trainer/shared-types';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { createHash, randomUUID } from 'crypto';

const DISPATCH_EVENT = 'job.benchmark.dispatch';

type Actor = { id: string; role: string };
const err = (code: string, message: string, status: number) =>
  new HttpException({ error: { code, message, requestId: '' } }, status);

const RUN_FIELDS = [
  'id', 'name', 'description', 'status', 'evaluation_count', 'completed_count', 'failed_count',
  'queued_at', 'started_at', 'finished_at', 'stop_requested_at', 'stopped_at', 'cloned_from_run_id',
  'created_at', 'created_by_user_id', 'updated_at',
] as const;

@Injectable()
export class BenchmarksService {
  constructor(
    @Inject(DB_PROVIDER) private readonly db: Kysely<Database>,
    private readonly auditService: AuditService,
    private readonly outboxService: OutboxService,
  ) {}

  async create(
    input: { name: string; description?: string | null; model_ids: string[]; training_dataset_ids: string[] },
    actor: Actor,
  ) {
    const name = input.name.trim();
    if (!name || name.length > 150) throw err(errorCode.VALIDATION_FAILED, 'name must be 1-150 chars', 400);
    const modelIds = [...new Set(input.model_ids ?? [])];
    const datasetIds = [...new Set(input.training_dataset_ids ?? [])];
    if (modelIds.length === 0) throw err(errorCode.BENCHMARK_NO_MODELS, 'at least one model is required', 400);
    if (datasetIds.length === 0) throw err(errorCode.BENCHMARK_NO_DATASETS, 'at least one dataset is required', 400);

    const correlationId = randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const models = await trx.selectFrom('models').select(['id', 'status', 'task_type', 'checksum'])
        .where('id', 'in', modelIds).execute();
      if (models.length !== modelIds.length) {
        const found = new Set(models.map((m) => m.id));
        const missing = modelIds.find((m) => !found.has(m));
        throw err(errorCode.MODEL_NOT_FOUND, `model ${missing} not found`, 404);
      }
      const datasets = await trx.selectFrom('training_datasets').select(['id', 'status', 'task_type', 'configuration_hash'])
        .where('id', 'in', datasetIds).execute();
      if (datasets.length !== datasetIds.length) {
        const found = new Set(datasets.map((d) => d.id));
        const missing = datasetIds.find((d) => !found.has(d));
        throw err(errorCode.TRAINING_DATASET_NOT_FOUND, `training dataset ${missing} not found`, 404);
      }
      for (const m of models) {
        if (m.status !== 'AVAILABLE') throw err(errorCode.BENCHMARK_MODEL_NOT_AVAILABLE, `model ${m.id} is not AVAILABLE`, 409);
      }
      for (const d of datasets) {
        if (d.status !== 'READY') throw err(errorCode.BENCHMARK_DATASET_NOT_READY, `dataset ${d.id} is not READY`, 409);
      }
      for (const m of models) {
        for (const d of datasets) {
          if (m.task_type !== d.task_type) throw err(errorCode.BENCHMARK_TASK_TYPE_MISMATCH, 'model/dataset task type mismatch', 400);
        }
      }

      const { id } = await trx.insertInto('benchmark_runs').values({
        name, description: input.description ?? null, status: 'QUEUED',
        evaluation_count: modelIds.length * datasetIds.length, queued_at: sql`now()`,
        created_by_user_id: actor.id,
      }).returning('id').executeTakeFirstOrThrow();

      const orderedModels = modelIds.map((mid) => models.find((m) => m.id === mid)!);
      const orderedDatasets = datasetIds.map((dsId) => datasets.find((d) => d.id === dsId)!);
      for (let i = 0; i < orderedModels.length; i++) {
        await trx.insertInto('benchmark_run_models').values({
          benchmark_run_id: id, model_id: orderedModels[i].id, sort_order: i,
          model_checksum_snapshot: orderedModels[i].checksum,
        }).execute();
      }
      for (let i = 0; i < orderedDatasets.length; i++) {
        await trx.insertInto('benchmark_run_datasets').values({
          benchmark_run_id: id, training_dataset_id: orderedDatasets[i].id, sort_order: i,
          dataset_configuration_hash: orderedDatasets[i].configuration_hash,
        }).execute();
      }

      for (const m of orderedModels) {
        for (const d of orderedDatasets) {
          const { id: evalId } = await trx.insertInto('benchmark_evaluations').values({
            benchmark_run_id: id, model_id: m.id, training_dataset_id: d.id, status: 'QUEUED',
          }).returning('id').executeTakeFirstOrThrow();

          const assignmentToken = randomUUID();
          const snapshot = { benchmark_evaluation_id: evalId, model_id: m.id, training_dataset_id: d.id };
          const { id: jobExecutionId } = await trx.insertInto('job_executions').values({
            job_type: 'BENCHMARK_EVALUATION', job_id: evalId, assignment_token: assignmentToken,
            configuration_snapshot: snapshot as Record<string, unknown>,
            configuration_hash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
            correlation_id: correlationId,
          }).returning('id').executeTakeFirstOrThrow();

          await this.outboxService.enqueue({
            eventType: DISPATCH_EVENT, aggregateTypeCode: 'JOB_EXECUTION', aggregateId: jobExecutionId,
            payload: {
              job_execution_id: jobExecutionId, assignment_token: assignmentToken, job_type: 'BENCHMARK_EVALUATION',
              benchmark_evaluation_id: evalId, benchmark_run_id: id, correlation_id: correlationId, attempt_number: 1,
            } as Record<string, unknown>,
            correlationId,
          }, trx);
        }
      }

      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id, actionCode: 'BENCHMARK_SUBMITTED',
        resourceTypeCode: 'BENCHMARK_RUN', resourceId: id, result: 'SUCCESS', correlationId,
        afterSnapshot: { name, models: modelIds, datasets: datasetIds },
        metadata: { evaluations: modelIds.length * datasetIds.length },
      }, trx);

      return trx.selectFrom('benchmark_runs').select(RUN_FIELDS).where('id', '=', id).executeTakeFirstOrThrow();
    });
  }

  private static readonly TERMINAL_STATUSES = new Set(['COMPLETED', 'PARTIALLY_FAILED', 'FAILED', 'CANCELLED', 'STOPPED']);

  async requestStop(id: string, actor: Actor) {
    const correlationId = randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const run = await trx.selectFrom('benchmark_runs').select(['id', 'status']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!run) throw err(errorCode.BENCHMARK_RUN_NOT_FOUND, 'benchmark run not found', 404);

      if (run.status === 'RUNNING') {
        await trx.updateTable('benchmark_runs').set({
          status: 'STOPPING', stop_requested_at: sql`now()`, stop_requested_by_user_id: actor.id, updated_at: sql`now()`,
        }).where('id', '=', id).execute();
        await trx.updateTable('benchmark_evaluations').set({ status: 'STOPPING' })
          .where('benchmark_run_id', '=', id).where('status', 'in', ['QUEUED', 'RUNNING']).execute();
        await this.auditService.append({
          actorType: 'USER', actorUserId: actor.id, actionCode: 'BENCHMARK_RUN_STOP_REQUESTED',
          resourceTypeCode: 'BENCHMARK_RUN', resourceId: id, result: 'SUCCESS', correlationId,
        }, trx);
        return { id, status: 'STOPPING' as const };
      }
      if (run.status === 'QUEUED') {
        await trx.updateTable('benchmark_runs').set({
          status: 'CANCELLED', finished_at: sql`now()`, updated_at: sql`now()`,
        }).where('id', '=', id).execute();
        await trx.updateTable('benchmark_evaluations').set({ status: 'CANCELLED', finished_at: sql`now()` })
          .where('benchmark_run_id', '=', id).where('status', 'in', ['PENDING', 'QUEUED']).execute();
        await this.auditService.append({
          actorType: 'USER', actorUserId: actor.id, actionCode: 'BENCHMARK_RUN_CANCELLED',
          resourceTypeCode: 'BENCHMARK_RUN', resourceId: id, result: 'SUCCESS', correlationId,
        }, trx);
        return { id, status: 'CANCELLED' as const };
      }
      throw err(errorCode.BENCHMARK_NOT_STOPPABLE, `run in ${run.status} cannot be stopped/cancelled`, 409);
    });
  }

  /**
   * In-place restart: same benchmark_runs row and same benchmark_evaluations rows, new
   * job_executions attempt per evaluation. Unlike a clone, no new run is created — the
   * previous attempt's history stays in job_executions under the same evaluation ids.
   */
  async retry(id: string, actor: Actor) {
    const correlationId = randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const run = await trx.selectFrom('benchmark_runs').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!run) throw err(errorCode.BENCHMARK_RUN_NOT_FOUND, 'benchmark run not found', 404);
      if (!BenchmarksService.TERMINAL_STATUSES.has(run.status)) {
        throw err(errorCode.BENCHMARK_NOT_RETRYABLE, `run is ${run.status}, only terminal runs can be retried`, 409);
      }

      const evaluations = await trx.selectFrom('benchmark_evaluations as be')
        .innerJoin('models as m', 'm.id', 'be.model_id')
        .innerJoin('training_datasets as d', 'd.id', 'be.training_dataset_id')
        .select(['be.id', 'be.model_id', 'be.training_dataset_id', 'm.status as model_status', 'd.status as dataset_status'])
        .where('be.benchmark_run_id', '=', id).execute();
      if (evaluations.length === 0) throw err(errorCode.BENCHMARK_NO_MODELS, 'run has no evaluations', 400);
      for (const e of evaluations) {
        if (e.model_status !== 'AVAILABLE') throw err(errorCode.BENCHMARK_MODEL_NOT_AVAILABLE, `model ${e.model_id} is not AVAILABLE`, 409);
        if (e.dataset_status !== 'READY') throw err(errorCode.BENCHMARK_DATASET_NOT_READY, `dataset ${e.training_dataset_id} is not READY`, 409);
      }

      for (const e of evaluations) {
        await trx.updateTable('benchmark_evaluations').set({
          status: 'QUEUED', started_at: null, finished_at: null, stopped_at: null,
          failure_code: null, failure_message: null,
          map50: null, map50_95: null, precision: null, recall: null, f1: null, metrics: {},
        }).where('id', '=', e.id).execute();

        const { attempt_number: lastAttempt } = await trx.selectFrom('job_executions')
          .select('attempt_number').where('job_type', '=', 'BENCHMARK_EVALUATION').where('job_id', '=', e.id)
          .orderBy('attempt_number', 'desc').limit(1).executeTakeFirstOrThrow();
        const nextAttempt = lastAttempt + 1;

        const assignmentToken = randomUUID();
        const snapshot = { benchmark_evaluation_id: e.id, model_id: e.model_id, training_dataset_id: e.training_dataset_id };
        const { id: jobExecutionId } = await trx.insertInto('job_executions').values({
          job_type: 'BENCHMARK_EVALUATION', job_id: e.id, attempt_number: nextAttempt, assignment_token: assignmentToken,
          configuration_snapshot: snapshot as Record<string, unknown>,
          configuration_hash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
          correlation_id: correlationId,
        }).returning('id').executeTakeFirstOrThrow();

        await this.outboxService.enqueue({
          eventType: DISPATCH_EVENT, aggregateTypeCode: 'JOB_EXECUTION', aggregateId: jobExecutionId,
          payload: {
            job_execution_id: jobExecutionId, assignment_token: assignmentToken, job_type: 'BENCHMARK_EVALUATION',
            benchmark_evaluation_id: e.id, benchmark_run_id: id, correlation_id: correlationId, attempt_number: nextAttempt,
          } as Record<string, unknown>,
          correlationId,
        }, trx);
      }

      await trx.updateTable('benchmark_runs').set({
        status: 'QUEUED', queued_at: sql`now()`, started_at: null, finished_at: null,
        stop_requested_at: null, stop_requested_by_user_id: null, stopped_at: null,
        completed_count: 0, failed_count: 0, updated_at: sql`now()`,
      }).where('id', '=', id).execute();

      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id, actionCode: 'BENCHMARK_RUN_RETRIED',
        resourceTypeCode: 'BENCHMARK_RUN', resourceId: id, result: 'SUCCESS', correlationId,
        metadata: { evaluations: evaluations.length },
      }, trx);

      return trx.selectFrom('benchmark_runs').select(RUN_FIELDS).where('id', '=', id).executeTakeFirstOrThrow();
    });
  }

  async get(id: string) {
    const row = await this.db.selectFrom('benchmark_runs').select(RUN_FIELDS).where('id', '=', id).executeTakeFirst();
    if (!row) throw err(errorCode.BENCHMARK_RUN_NOT_FOUND, 'benchmark run not found', 404);
    const evaluations = await this.db.selectFrom('benchmark_evaluations as be')
      .leftJoin('models as m', 'm.id', 'be.model_id')
      .leftJoin('training_datasets as td', 'td.id', 'be.training_dataset_id')
      .select([
        'be.id', 'be.model_id', 'be.training_dataset_id', 'be.status',
        'be.map50', 'be.map50_95', 'be.precision', 'be.recall', 'be.f1',
        'be.failure_code', 'be.started_at', 'be.finished_at',
        'm.name as model_name', 'td.name as training_dataset_name',
      ])
      .where('be.benchmark_run_id', '=', id).orderBy('be.created_at').execute();
    return { ...row, evaluations };
  }

  async getEvaluation(runId: string, evalId: string) {
    const row = await this.db.selectFrom('benchmark_evaluations').selectAll()
      .where('id', '=', evalId).where('benchmark_run_id', '=', runId).executeTakeFirst();
    if (!row) throw err(errorCode.BENCHMARK_EVALUATION_NOT_FOUND, 'evaluation not found', 404);
    return row;
  }

  async list(params: { page: number; size: number; status?: string }) {
    const size = Math.min(Math.max(params.size, 1), 200);
    const offset = (params.page - 1) * size;
    let q = this.db.selectFrom('benchmark_runs');
    if (params.status) q = q.where('status', '=', params.status as never);
    const [{ count }] = await q.select(sql<number>`count(*)`.as('count')).execute();
    const rows = await q.select([
      'id', 'name', 'description', 'status', 'evaluation_count', 'completed_count', 'failed_count',
      'created_by_user_id', 'created_at', 'finished_at',
    ]).orderBy('created_at', 'desc').limit(size).offset(offset).execute();

    const runIds = rows.map((r) => r.id);
    if (runIds.length === 0) return { items: [], total: Number(count), page: params.page, size };

    const modelRows = await this.db.selectFrom('benchmark_run_models as brm')
      .innerJoin('models as m', 'm.id', 'brm.model_id')
      .select(['brm.benchmark_run_id', 'm.id as model_id', 'm.name as model_name'])
      .where('brm.benchmark_run_id', 'in', runIds)
      .orderBy('brm.sort_order').execute();

    const datasetRows = await this.db.selectFrom('benchmark_run_datasets as brd')
      .innerJoin('training_datasets as td', 'td.id', 'brd.training_dataset_id')
      .select(['brd.benchmark_run_id', 'td.id as dataset_id', 'td.name as dataset_name', 'td.dataset_type_id'])
      .where('brd.benchmark_run_id', 'in', runIds)
      .orderBy('brd.sort_order').execute();

    const typeIds = [...new Set(datasetRows.map((d) => d.dataset_type_id).filter(Boolean))] as string[];
    const typeRows = typeIds.length > 0
      ? await this.db.selectFrom('dataset_types').select(['id', 'name']).where('id', 'in', typeIds).execute()
      : [];
    const typeMap = new Map(typeRows.map((t) => [t.id, t.name]));

    const items = rows.map((r) => {
      const models = modelRows.filter((m) => m.benchmark_run_id === r.id);
      const datasets = datasetRows.filter((d) => d.benchmark_run_id === r.id);
      const firstTypeId = datasets.find((d) => d.dataset_type_id)?.dataset_type_id ?? null;
      return {
        ...r,
        model_ids: models.map((m) => m.model_id),
        model_names: models.map((m) => m.model_name),
        training_dataset_ids: datasets.map((d) => d.dataset_id),
        dataset_names: datasets.map((d) => d.dataset_name),
        dataset_type_id: firstTypeId,
        dataset_type_name: firstTypeId ? (typeMap.get(firstTypeId) ?? null) : null,
      };
    });

    return { items, total: Number(count), page: params.page, size };
  }
}
