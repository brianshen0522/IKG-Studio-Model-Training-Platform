import { Inject, Injectable, HttpException } from '@nestjs/common';
import { DB_PROVIDER } from '../database/database.module';
import { type Kysely, type Transaction, sql } from 'kysely';
import type { Database, DatasetTaskType } from '@model-trainer/db';
import { errorCode } from '@model-trainer/shared-types';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { MinioService } from '../minio/minio.service';
import { createHash, randomUUID } from 'crypto';

const PHASE1_TASK_TYPES: DatasetTaskType[] = ['DETECT', 'OBB'];
const INGEST_EVENT = 'job.model_ingest.dispatch';
const MODEL_SCAN_EVENT = 'job.model_scan.dispatch';
const MODEL_DELETE_EVENT = 'job.model_delete.dispatch';

type Actor = { id: string; role: string };
type Exec = Kysely<Database>;
const err = (code: string, message: string, status: number, details?: Record<string, unknown>) =>
  new HttpException({ error: { code, message, details, requestId: '' } }, status);

const MODEL_FIELDS = [
  'id', 'name', 'version_label', 'description', 'dataset_type_id', 'task_type', 'source_type',
  'status', 'relative_path', 'original_filename', 'file_size_bytes',
  'checksum_algorithm', 'checksum', 'source_url', 'source_artifact_id', 'source_training_job_id',
  'architecture_metadata', 'runtime_metadata', 'validation_summary', 'row_version',
  'created_at', 'created_by_user_id', 'available_at', 'archived_at',
] as const;

const TASK_FIELDS = [
  'id', 'source_type', 'status', 'requested_name', 'requested_version_label', 'requested_description',
  'dataset_type_id', 'task_type', 'original_filename', 'source_url', 'expected_checksum',
  'expected_size_bytes', 'progress_percent', 'progress_message', 'result_model_id',
  'failure_code', 'failure_message', 'created_at', 'created_by_user_id', 'started_at', 'finished_at',
] as const;

@Injectable()
export class ModelsService {
  constructor(
    @Inject(DB_PROVIDER) private readonly db: Kysely<Database>,
    private readonly auditService: AuditService,
    private readonly outboxService: OutboxService,
    private readonly minio: MinioService,
  ) {}

  private readonly uploadBucket = process.env.MINIO_BUCKET ?? 'artifacts';

  private async assertDatasetTypeUsable(exec: Exec, datasetTypeId: string) {
    const res = await sql<{ enabled: boolean }>`
      WITH RECURSIVE anc AS (
        SELECT id, parent_id, enabled FROM app.dataset_types WHERE id = ${datasetTypeId}
        UNION ALL
        SELECT p.id, p.parent_id, p.enabled FROM app.dataset_types p JOIN anc a ON a.parent_id = p.id
      )
      SELECT bool_and(enabled) AS enabled FROM anc
    `.execute(exec);
    if (res.rows.length === 0 || res.rows[0].enabled === null || !res.rows[0].enabled) {
      throw err(errorCode.MODEL_DATASET_TYPE_INVALID, 'dataset type not found or disabled', 400);
    }
  }

  private async dispatchIngest(
    trx: Transaction<Database>, taskId: string, correlationId: string,
  ) {
    const assignmentToken = randomUUID();
    const snapshot = { model_ingest_task_id: taskId };
    const { id: jobExecutionId } = await trx.insertInto('job_executions').values({
      job_type: 'MODEL_INGEST', job_id: taskId, assignment_token: assignmentToken,
      configuration_snapshot: snapshot as Record<string, unknown>,
      configuration_hash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
      correlation_id: correlationId,
    }).returning('id').executeTakeFirstOrThrow();

    await this.outboxService.enqueue({
      eventType: INGEST_EVENT, aggregateTypeCode: 'JOB_EXECUTION', aggregateId: jobExecutionId,
      payload: {
        job_execution_id: jobExecutionId, assignment_token: assignmentToken, job_type: 'MODEL_INGEST',
        model_ingest_task_id: taskId, correlation_id: correlationId, attempt_number: 1,
      } as Record<string, unknown>,
      correlationId,
    }, trx);
    return jobExecutionId;
  }

  async ingestFromUrl(
    input: {
      name: string; version_label?: string | null; description?: string | null;
      dataset_type_id: string; task_type: DatasetTaskType; source_url: string;
      expected_checksum?: string | null; expected_size_bytes?: number | null;
    },
    actor: Actor,
  ) {
    const name = input.name.trim();
    if (!name || name.length > 150) throw err(errorCode.VALIDATION_FAILED, 'name must be 1-150 chars', 400);
    if (!PHASE1_TASK_TYPES.includes(input.task_type)) {
      throw err(errorCode.VALIDATION_FAILED, 'task_type must be DETECT or OBB in phase 1', 400);
    }
    let parsed: URL;
    try { parsed = new URL(input.source_url); } catch { throw err(errorCode.MODEL_INVALID_URL, 'source_url is not a valid URL', 400); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw err(errorCode.MODEL_URL_SCHEME_NOT_ALLOWED, 'only http(s) URLs are supported', 400);
    }
    if (parsed.protocol === 'http:') {
      const s = await this.db.selectFrom('system_settings').select('value')
        .where('setting_key', '=', 'model_download_allow_http').executeTakeFirst();
      if (!s || (s.value as unknown) !== true) throw err(errorCode.MODEL_URL_SCHEME_NOT_ALLOWED, 'http:// downloads are disabled; use https', 400);
    }

    const correlationId = randomUUID();
    return this.db.transaction().execute(async (trx) => {
      await this.assertDatasetTypeUsable(trx, input.dataset_type_id);

      const { id: taskId } = await trx.insertInto('model_ingest_tasks').values({
        source_type: 'URL_DOWNLOAD', status: 'QUEUED', requested_name: name,
        requested_version_label: input.version_label ?? null, requested_description: input.description ?? null,
        dataset_type_id: input.dataset_type_id, task_type: input.task_type, source_url: input.source_url,
        expected_checksum: input.expected_checksum ?? null, expected_size_bytes: input.expected_size_bytes ?? null,
        correlation_id: correlationId, created_by_user_id: actor.id,
      }).returning('id').executeTakeFirstOrThrow();

      await this.dispatchIngest(trx, taskId, correlationId);

      const row = await trx.selectFrom('model_ingest_tasks').select(TASK_FIELDS).where('id', '=', taskId).executeTakeFirstOrThrow();
      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id, actionCode: 'MODEL_INGEST_REQUESTED',
        resourceTypeCode: 'MODEL_INGEST', resourceId: taskId, result: 'SUCCESS', correlationId,
        afterSnapshot: { source_type: 'URL_DOWNLOAD', name, source_url: input.source_url },
      }, trx);
      return row;
    });
  }

  async uploadModel(
    input: {
      name: string; version_label?: string | null; description?: string | null;
      dataset_type_id: string; task_type: DatasetTaskType; original_filename: string;
      expected_checksum?: string | null;
    },
    file: Buffer,
    actor: Actor,
  ) {
    const name = input.name.trim();
    if (!name || name.length > 150) throw err(errorCode.VALIDATION_FAILED, 'name must be 1-150 chars', 400);
    if (!PHASE1_TASK_TYPES.includes(input.task_type)) {
      throw err(errorCode.VALIDATION_FAILED, 'task_type must be DETECT or OBB in phase 1', 400);
    }
    if (!input.original_filename?.toLowerCase().endsWith('.pt')) {
      throw err(errorCode.MODEL_UPLOAD_INVALID, 'original filename must end with .pt', 400);
    }
    if (!file || file.length <= 0) throw err(errorCode.MODEL_UPLOAD_INVALID, 'uploaded file is empty', 400);
    const maxSizeRow = await this.db.selectFrom('system_settings').select('value')
      .where('setting_key', '=', 'model_upload_max_size_bytes').executeTakeFirst();
    const maxSize = typeof maxSizeRow?.value === 'number' ? maxSizeRow.value : 2 * 1024 * 1024 * 1024;
    if (file.length > maxSize) throw err(errorCode.MODEL_UPLOAD_INVALID, `file exceeds max upload size of ${maxSize} bytes`, 400);

    const correlationId = randomUUID();
    const taskId = randomUUID();
    const objectKey = `temporary/model-ingest/${taskId}/${input.original_filename}`;
    await this.minio.putBuffer(this.uploadBucket, objectKey, file, 'application/octet-stream');

    try {
      return await this.db.transaction().execute(async (trx) => {
        await this.assertDatasetTypeUsable(trx, input.dataset_type_id);

        await trx.insertInto('model_ingest_tasks').values({
          id: taskId, source_type: 'UPLOAD', status: 'QUEUED', requested_name: name,
          requested_version_label: input.version_label ?? null, requested_description: input.description ?? null,
          dataset_type_id: input.dataset_type_id, task_type: input.task_type,
          original_filename: input.original_filename,
          expected_checksum: input.expected_checksum ?? null, expected_size_bytes: file.length,
          temporary_object_key: objectKey,
          correlation_id: correlationId, created_by_user_id: actor.id,
        }).execute();

        await this.dispatchIngest(trx, taskId, correlationId);

        const row = await trx.selectFrom('model_ingest_tasks').select(TASK_FIELDS).where('id', '=', taskId).executeTakeFirstOrThrow();
        await this.auditService.append({
          actorType: 'USER', actorUserId: actor.id, actionCode: 'MODEL_INGEST_REQUESTED',
          resourceTypeCode: 'MODEL_INGEST', resourceId: taskId, result: 'SUCCESS', correlationId,
          afterSnapshot: { source_type: 'UPLOAD', name, original_filename: input.original_filename },
        }, trx);
        return row;
      });
    } catch (e) {
      await this.minio.removeObject(this.uploadBucket, objectKey).catch(() => undefined);
      throw e;
    }
  }

  async getIngestTask(id: string) {
    const row = await this.db.selectFrom('model_ingest_tasks').select(TASK_FIELDS).where('id', '=', id).executeTakeFirst();
    if (!row) throw err(errorCode.MODEL_INGEST_TASK_NOT_FOUND, 'ingest task not found', 404);
    return row;
  }

  async listModels(params: { page: number; size: number; dataset_type_id?: string; task_type?: string; source_type?: string; status?: string; archived?: boolean }) {
    const size = Math.min(Math.max(params.size, 1), 100);
    const offset = (params.page - 1) * size;
    let q = this.db.selectFrom('models');
    if (params.dataset_type_id) q = q.where('dataset_type_id', '=', params.dataset_type_id);
    if (params.task_type) q = q.where('task_type', '=', params.task_type as DatasetTaskType);
    if (params.source_type) q = q.where('source_type', '=', params.source_type as never);
    if (params.status) q = q.where('status', '=', params.status as never);
    if (!params.archived) q = q.where('status', '!=', 'DELETED');
    const [{ count }] = await q.select(sql<number>`count(*)`.as('count')).execute();
    const items = await q.select([
      'id', 'name', 'version_label', 'dataset_type_id', 'task_type', 'source_type', 'status',
      'file_size_bytes', 'checksum', 'created_by_user_id', 'created_at', 'available_at', 'archived_at',
      // The list is where models get compared, so the architecture and the image size
      // they were trained at have to come back with it, not only on the detail page.
      'architecture_metadata',
    ]).orderBy('created_at', 'desc').limit(size).offset(offset).execute();
    return { items, total: Number(count), page: params.page, size };
  }

  async getModel(id: string) {
    const row = await this.db.selectFrom('models').select(MODEL_FIELDS).where('id', '=', id).executeTakeFirst();
    if (!row) throw err(errorCode.MODEL_NOT_FOUND, 'model not found', 404);
    return row;
  }

  /**
   * What deleting this model would leave dangling, purely informational — nothing here
   * blocks the delete (see ModelsService.deleteModel). Used to warn the admin before
   * they confirm.
   */
  async associations(id: string) {
    const m = await this.db.selectFrom('models').select('id').where('id', '=', id).executeTakeFirst();
    if (!m) throw err(errorCode.MODEL_NOT_FOUND, 'model not found', 404);
    const [asBase, asResult, benchmarks] = await Promise.all([
      this.db.selectFrom('training_jobs').select(['id', 'name']).where('base_model_id', '=', id).execute(),
      this.db.selectFrom('training_jobs').select(['id', 'name']).where('result_model_id', '=', id).execute(),
      this.db.selectFrom('benchmark_run_models').select('benchmark_run_id').where('model_id', '=', id).execute(),
    ]);
    return {
      training_jobs_as_base: asBase,
      training_jobs_as_result: asResult,
      benchmark_run_ids: benchmarks.map((b) => b.benchmark_run_id),
    };
  }

  /**
   * Local exception to the "artifacts are immutable" rule (see AGENTS.md), same as
   * ModelConversionsService.remove: soft-delete (status='DELETED', row kept) so
   * training_jobs.base_model_id/result_model_id and benchmark rows that reference this
   * model keep resolving — their history is untouched, only this model's own DB fields
   * and disk file disappear. The .pt itself is unlinked by the training worker (only it
   * has filesystem access), dispatched over the outbox like scan/ingest/conversion.
   */
  async deleteModel(id: string, actor: Actor) {
    const correlationId = randomUUID();
    let objectKeys: { bucket: string; key: string }[] = [];

    const result = await this.db.transaction().execute(async (trx) => {
      const m = await trx.selectFrom('models').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!m) throw err(errorCode.MODEL_NOT_FOUND, 'model not found', 404);
      if (m.status === 'DELETED') throw err(errorCode.MODEL_ALREADY_DELETED, 'already deleted', 409);

      const conversions = await trx.selectFrom('model_conversions')
        .select(['id', 'artifact_id']).where('model_id', '=', id).execute();
      const artifactIds = conversions.map((c) => c.artifact_id).filter((x): x is string => !!x);
      if (artifactIds.length > 0) {
        const artifacts = await trx.selectFrom('artifacts')
          .select(['id', 'bucket_name', 'object_key']).where('id', 'in', artifactIds).execute();
        objectKeys = artifacts.map((a) => ({ bucket: a.bucket_name, key: a.object_key }));
        await trx.deleteFrom('artifacts').where('id', 'in', artifactIds).execute();
      }
      if (conversions.length > 0) {
        await trx.deleteFrom('model_conversions').where('model_id', '=', id).execute();
      }

      await trx.updateTable('models')
        .set({ status: 'DELETED', archived_at: sql`now()`, archived_by_user_id: actor.id, row_version: m.row_version + 1 })
        .where('id', '=', id).execute();

      await this.outboxService.enqueue({
        eventType: MODEL_DELETE_EVENT, aggregateTypeCode: 'MODEL', aggregateId: id,
        payload: {
          model_id: id, model_path: m.model_path, relative_path: m.relative_path,
          correlation_id: correlationId,
        } as Record<string, unknown>,
        correlationId,
      }, trx);

      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id, actionCode: 'MODEL_DELETED',
        resourceTypeCode: 'MODEL', resourceId: id, result: 'SUCCESS', correlationId,
        beforeSnapshot: { status: m.status },
        metadata: { conversions_removed: conversions.length },
      }, trx);
      return { id, status: 'DELETED' as const };
    });

    if (objectKeys.length > 0) {
      await Promise.all(objectKeys.map((o) => this.minio.removeObject(o.bucket, o.key).catch(() => undefined)));
    }
    return result;
  }
  /**
   * Ask the training worker to walk the Model Root and register any .pt it finds.
   * Models are discovered rather than imported by hand, so metadata (task, image size
   * the model was trained at, YOLO version and size) comes from the checkpoint itself.
   */
  async requestScan(datasetTypeId: string | null, actor: Actor) {
    const correlationId = randomUUID();
    return this.db.transaction().execute(async (trx) => {
      if (datasetTypeId) {
        const dt = await trx.selectFrom('dataset_types').select(['id', 'model_path'])
          .where('id', '=', datasetTypeId).executeTakeFirst();
        if (!dt) throw err(errorCode.DATASET_TYPE_NOT_FOUND, 'dataset type not found', 404);
        if (!dt.model_path) {
          throw err(errorCode.VALIDATION_FAILED, 'dataset type has no model_path configured', 400);
        }
      }
      await this.outboxService.enqueue({
        eventType: MODEL_SCAN_EVENT,
        aggregateTypeCode: 'MODEL',
        aggregateId: datasetTypeId ?? correlationId,
        payload: { dataset_type_id: datasetTypeId, correlation_id: correlationId } as Record<string, unknown>,
        correlationId,
      }, trx);
      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id, actionCode: 'MODEL_SCAN_REQUESTED',
        resourceTypeCode: 'MODEL', resourceId: datasetTypeId ?? correlationId,
        result: 'SUCCESS', correlationId,
        metadata: { dataset_type_id: datasetTypeId },
      }, trx);
      return { dispatched: true, dataset_type_id: datasetTypeId, correlation_id: correlationId };
    });
  }

  /**
   * Outcome of one dispatched scan. The scan runs in the training worker, so the POST
   * can only say "dispatched" — the caller polls this until the worker's completion
   * receipt lands, which is what turns the button into a real result.
   */
  async scanStatus(correlationId: string) {
    const row = await this.db
      .selectFrom('audit_logs')
      .select(['occurred_at', 'metadata'])
      .where('correlation_id', '=', correlationId)
      .where('action_code', '=', 'MODEL_SCAN_COMPLETED')
      .executeTakeFirst();
    if (!row) return { status: 'RUNNING' as const };
    const m = (row.metadata ?? {}) as Record<string, number>;
    return {
      status: 'COMPLETED' as const,
      finished_at: row.occurred_at,
      types: m.types ?? 0,
      found: m.found ?? 0,
      registered: m.registered ?? 0,
      backfilled: m.backfilled ?? 0,
      skipped: m.skipped ?? 0,
      roots_missing: m.roots_missing ?? 0,
    };
  }

}
