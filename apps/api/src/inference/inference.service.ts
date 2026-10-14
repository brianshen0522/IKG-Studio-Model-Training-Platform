import { Inject, Injectable, HttpException } from '@nestjs/common';
import { DB_PROVIDER } from '../database/database.module';
import { type Kysely, sql } from 'kysely';
import type { Database } from '@model-trainer/db';
import { errorCode } from '@model-trainer/shared-types';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { createHash, randomUUID } from 'crypto';

const DISPATCH_EVENT = 'job.inference.dispatch';

// Fixed for now (docs/inference-compare-plan.md §2). Stored on every run, so
// making them adjustable later does not change what an old run's results mean.
const CONF_THRESHOLD = 0.7;
const IOU_THRESHOLD = 0.5;

// Only detection boxes are compared in this phase; OBB needs rotated-box IoU.
const SUPPORTED_TASK_TYPES = new Set(['DETECT']);

type Actor = { id: string; role: string };
const err = (code: string, message: string, status: number) =>
  new HttpException({ error: { code, message, requestId: '' } }, status);

const RUN_FIELDS = [
  'id', 'name', 'description', 'dataset_type_id', 'model_id', 'model_checksum_snapshot',
  'conf_threshold', 'iou_threshold', 'device', 'status',
  'dataset_count', 'completed_count', 'failed_count',
  'queued_at', 'started_at', 'finished_at', 'stop_requested_at', 'stopped_at',
  'created_at', 'created_by_user_id', 'updated_at',
] as const;

@Injectable()
export class InferenceService {
  constructor(
    @Inject(DB_PROVIDER) private readonly db: Kysely<Database>,
    private readonly auditService: AuditService,
    private readonly outboxService: OutboxService,
  ) {}

  /**
   * One run, one job per source dataset. Whether the model's class names match
   * each source's is checked by the worker, not here: the class names live in
   * the .pt file and are not recorded on the models row.
   */
  async create(
    input: { name: string; description?: string | null; model_id: string; source_dataset_ids: string[]; device?: string },
    actor: Actor,
  ) {
    const name = input.name.trim();
    if (!name || name.length > 150) throw err(errorCode.VALIDATION_FAILED, 'name must be 1-150 chars', 400);
    const sourceIds = [...new Set(input.source_dataset_ids ?? [])];
    if (sourceIds.length === 0) throw err(errorCode.INFERENCE_NO_DATASETS, 'at least one source dataset is required', 400);

    const correlationId = randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const model = await trx.selectFrom('models')
        .select(['id', 'status', 'task_type', 'checksum', 'dataset_type_id'])
        .where('id', '=', input.model_id).executeTakeFirst();
      if (!model) throw err(errorCode.MODEL_NOT_FOUND, `model ${input.model_id} not found`, 404);
      if (model.status !== 'AVAILABLE') {
        throw err(errorCode.INFERENCE_MODEL_NOT_AVAILABLE, `model ${model.id} is not AVAILABLE`, 409);
      }
      if (!SUPPORTED_TASK_TYPES.has(model.task_type)) {
        throw err(errorCode.INFERENCE_TASK_TYPE_UNSUPPORTED, `inference supports DETECT models only, not ${model.task_type}`, 400);
      }

      const sources = await trx.selectFrom('source_datasets')
        .select(['id', 'status', 'task_type', 'dataset_type_id', 'latest_scan_id'])
        .where('id', 'in', sourceIds).execute();
      if (sources.length !== sourceIds.length) {
        const found = new Set(sources.map((s) => s.id));
        const missing = sourceIds.find((s) => !found.has(s));
        throw err(errorCode.SOURCE_DATASET_NOT_FOUND, `source dataset ${missing} not found`, 404);
      }
      for (const s of sources) {
        if (s.status !== 'READY' || !s.latest_scan_id) {
          throw err(errorCode.SOURCE_DATASET_NOT_READY, `source dataset ${s.id} is not READY`, 409);
        }
        if (s.dataset_type_id !== model.dataset_type_id) {
          throw err(errorCode.INFERENCE_TYPE_MISMATCH, 'the model and every source dataset must belong to the same dataset type', 400);
        }
        if (s.task_type !== model.task_type) {
          throw err(errorCode.INFERENCE_TASK_TYPE_MISMATCH, `source dataset ${s.id} is ${s.task_type}, the model is ${model.task_type}`, 400);
        }
      }

      const dup = await trx.selectFrom('inference_runs').select('id')
        .where('dataset_type_id', '=', model.dataset_type_id)
        .where(sql`lower(name)`, '=', name.toLowerCase()).executeTakeFirst();
      if (dup) {
        throw err(errorCode.INFERENCE_NAME_TAKEN, `an inference run named "${name}" already exists in this dataset type`, 409);
      }

      const { id } = await trx.insertInto('inference_runs').values({
        name, description: input.description ?? null,
        dataset_type_id: model.dataset_type_id, model_id: model.id, model_checksum_snapshot: model.checksum,
        conf_threshold: CONF_THRESHOLD, iou_threshold: IOU_THRESHOLD,
        device: input.device ?? '', status: 'QUEUED', dataset_count: sourceIds.length,
        queued_at: sql`now()`, created_by_user_id: actor.id,
      }).returning('id').executeTakeFirstOrThrow();

      const ordered = sourceIds.map((sid) => sources.find((s) => s.id === sid)!);
      for (let i = 0; i < ordered.length; i++) {
        const source = ordered[i];
        const { id: runDatasetId } = await trx.insertInto('inference_run_datasets').values({
          inference_run_id: id, source_dataset_id: source.id, sort_order: i,
          source_scan_id_snapshot: source.latest_scan_id, status: 'QUEUED',
        }).returning('id').executeTakeFirstOrThrow();

        const assignmentToken = randomUUID();
        const snapshot = {
          inference_run_dataset_id: runDatasetId, model_id: model.id, model_checksum: model.checksum,
          source_dataset_id: source.id, source_scan_id: source.latest_scan_id,
          conf_threshold: CONF_THRESHOLD, iou_threshold: IOU_THRESHOLD,
        };
        const { id: jobExecutionId } = await trx.insertInto('job_executions').values({
          job_type: 'INFERENCE', job_id: runDatasetId, assignment_token: assignmentToken,
          configuration_snapshot: snapshot as Record<string, unknown>,
          configuration_hash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
          correlation_id: correlationId,
        }).returning('id').executeTakeFirstOrThrow();

        await this.outboxService.enqueue({
          eventType: DISPATCH_EVENT, aggregateTypeCode: 'JOB_EXECUTION', aggregateId: jobExecutionId,
          payload: {
            job_execution_id: jobExecutionId, assignment_token: assignmentToken, job_type: 'INFERENCE',
            inference_run_dataset_id: runDatasetId, inference_run_id: id,
            correlation_id: correlationId, attempt_number: 1,
          } as Record<string, unknown>,
          correlationId,
        }, trx);
      }

      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id, actionCode: 'INFERENCE_RUN_SUBMITTED',
        resourceTypeCode: 'INFERENCE_RUN', resourceId: id, result: 'SUCCESS', correlationId,
        afterSnapshot: { name, model_id: model.id, source_dataset_ids: sourceIds },
        metadata: { datasets: sourceIds.length, conf_threshold: CONF_THRESHOLD, iou_threshold: IOU_THRESHOLD },
      }, trx);

      return trx.selectFrom('inference_runs').select(RUN_FIELDS).where('id', '=', id).executeTakeFirstOrThrow();
    });
  }

  async get(id: string) {
    const row = await this.db.selectFrom('inference_runs as r')
      .leftJoin('models as m', 'm.id', 'r.model_id')
      .leftJoin('dataset_types as t', 't.id', 'r.dataset_type_id')
      .select(RUN_FIELDS.map((f) => `r.${f}` as const))
      .select(['m.name as model_name', 't.name as dataset_type_name'])
      .where('r.id', '=', id).executeTakeFirst();
    if (!row) throw err(errorCode.INFERENCE_RUN_NOT_FOUND, 'inference run not found', 404);
    const datasets = await this.db.selectFrom('inference_run_datasets as d')
      .leftJoin('source_datasets as s', 's.id', 'd.source_dataset_id')
      .select([
        'd.id', 'd.source_dataset_id', 'd.status', 'd.source_scan_id_snapshot',
        'd.image_count', 'd.processed_count', 'd.diff_image_count',
        'd.missing_count', 'd.extra_count', 'd.class_mismatch_count', 'd.zip_artifact_id',
        'd.failure_code', 'd.failure_message', 'd.started_at', 'd.finished_at', 'd.stopped_at',
        's.name as source_dataset_name',
        // The compare page warns when the source has been rescanned since.
        sql<boolean>`s.latest_scan_id IS DISTINCT FROM d.source_scan_id_snapshot`.as('source_changed'),
      ])
      .where('d.inference_run_id', '=', id).orderBy('d.sort_order').execute();
    return { ...row, datasets };
  }

  async list(params: { page: number; size: number; status?: string; datasetTypeId?: string }) {
    const size = Math.min(Math.max(params.size, 1), 200);
    const offset = (params.page - 1) * size;
    let q = this.db.selectFrom('inference_runs as r');
    if (params.status) q = q.where('r.status', '=', params.status as never);
    if (params.datasetTypeId) q = q.where('r.dataset_type_id', '=', params.datasetTypeId);
    const [{ count }] = await q.select(sql<number>`count(*)`.as('count')).execute();
    const rows = await q
      .leftJoin('models as m', 'm.id', 'r.model_id')
      .leftJoin('dataset_types as t', 't.id', 'r.dataset_type_id')
      .select([
        'r.id', 'r.name', 'r.description', 'r.dataset_type_id', 'r.model_id', 'r.device', 'r.status',
        'r.dataset_count', 'r.completed_count', 'r.failed_count',
        'r.created_by_user_id', 'r.created_at', 'r.finished_at',
        'm.name as model_name', 't.name as dataset_type_name',
      ])
      .orderBy('r.created_at', 'desc').limit(size).offset(offset).execute();

    const runIds = rows.map((r) => r.id);
    if (runIds.length === 0) return { items: [], total: Number(count), page: params.page, size };

    const datasetRows = await this.db.selectFrom('inference_run_datasets as d')
      .innerJoin('source_datasets as s', 's.id', 'd.source_dataset_id')
      .select(['d.inference_run_id', 's.id as source_dataset_id', 's.name as source_dataset_name', 'd.diff_image_count'])
      .where('d.inference_run_id', 'in', runIds)
      .orderBy('d.sort_order').execute();

    const items = rows.map((r) => {
      const datasets = datasetRows.filter((d) => d.inference_run_id === r.id);
      return {
        ...r,
        source_dataset_ids: datasets.map((d) => d.source_dataset_id),
        source_dataset_names: datasets.map((d) => d.source_dataset_name),
        diff_image_count: datasets.reduce((n, d) => n + d.diff_image_count, 0),
      };
    });
    return { items, total: Number(count), page: params.page, size };
  }
}
