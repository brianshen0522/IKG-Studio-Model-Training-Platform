import { Inject, Injectable, HttpException } from '@nestjs/common';
import { DB_PROVIDER } from '../database/database.module';
import { type Kysely, sql } from 'kysely';
import type { Database } from '@model-trainer/db';
import { errorCode, validateExportArgs } from '@model-trainer/shared-types';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { MinioService } from '../minio/minio.service';
import { createHash, randomUUID } from 'crypto';

const DISPATCH_EVENT = 'job.conversion.dispatch';
const CONFIG_SCHEMA_VERSION = 1;

type Actor = { id: string; role: string };
const err = (code: string, message: string, status: number, details?: Record<string, unknown>) =>
  new HttpException({ error: { code, message, details, requestId: '' } }, status);

const FIELDS = [
  'id', 'model_id', 'status', 'args', 'artifact_id', 'failure_code', 'failure_message',
  'requested_by_user_id', 'created_at', 'started_at', 'finished_at', 'row_version',
] as const;

/**
 * Platform-owned export arguments. `model`/`format` are derived from the conversion
 * itself; the rest would point export at other data or touch the worker's filesystem.
 * Mirrored by the worker's own reserved set in converter.py — keep both in step.
 */
const RESERVED_ARGS = new Set([
  'model', 'format', 'source', 'data', 'project', 'name', 'save_dir', 'exist_ok', 'resume', 'mode',
]);

/** INT8 needs a calibration dataset (a data.yaml), which a conversion does not have. */
const UNSUPPORTED_ARGS = new Set(['int8', 'quantize']);

function normalizeArgs(args: Record<string, unknown> | undefined, imgszDefault: number): Record<string, unknown> {
  const out: Record<string, unknown> = { imgsz: imgszDefault, ...(args ?? {}) };

  for (const k of RESERVED_ARGS) {
    if (k in out) throw err(errorCode.MODEL_CONVERSION_RESERVED_ARG, `${k} is set by the platform`, 400, { key: k });
  }
  for (const k of UNSUPPORTED_ARGS) {
    if (k in out) {
      throw err(
        errorCode.MODEL_CONVERSION_INT8_UNSUPPORTED,
        `${k} requires a calibration dataset with labels, which a conversion does not have`,
        400,
        { key: k },
      );
    }
  }

  const issues = validateExportArgs(out);
  if (issues.length > 0) {
    const detail = issues
      .map((i) => `${i.key}: ${i.message}${i.suggestion ? ` (did you mean ${i.suggestion}?)` : ''}`)
      .join('; ');
    throw err(errorCode.MODEL_CONVERSION_INVALID_ARGS, detail, 400, { issues });
  }
  return out;
}

@Injectable()
export class ModelConversionsService {
  constructor(
    @Inject(DB_PROVIDER) private readonly db: Kysely<Database>,
    private readonly auditService: AuditService,
    private readonly outboxService: OutboxService,
    private readonly minio: MinioService,
  ) {}

  async create(modelId: string, args: Record<string, unknown> | undefined, actor: Actor) {
    const correlationId = randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const model = await trx
        .selectFrom('models')
        .select(['id', 'status', 'task_type', 'name', 'architecture_metadata'])
        .where('id', '=', modelId)
        .executeTakeFirst();
      if (!model) throw err(errorCode.MODEL_NOT_FOUND, 'model not found', 404);
      if (model.status !== 'AVAILABLE') {
        throw err(errorCode.MODEL_CONVERSION_MODEL_NOT_AVAILABLE, `model is ${model.status}, only AVAILABLE models can be converted`, 409);
      }
      if (model.task_type !== 'DETECT' && model.task_type !== 'OBB') {
        throw err(errorCode.MODEL_CONVERSION_TASK_UNSUPPORTED, `${model.task_type} is not supported for OpenVINO conversion`, 400);
      }

      const trainedImgsz = Number((model.architecture_metadata as Record<string, unknown>)?.imgsz);
      const imgszDefault = Number.isFinite(trainedImgsz) && trainedImgsz > 0 ? trainedImgsz : 640;
      const hp = normalizeArgs(args, imgszDefault);

      const snapshot = {
        config_schema_version: CONFIG_SCHEMA_VERSION,
        model_id: modelId, task_type: model.task_type,
        args: hp,
      };
      const configHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

      const { id } = await trx.insertInto('model_conversions').values({
        model_id: modelId, status: 'QUEUED', args: hp, requested_by_user_id: actor.id,
      }).returning('id').executeTakeFirstOrThrow();

      const assignmentToken = randomUUID();
      const { id: jobExecutionId } = await trx.insertInto('job_executions').values({
        job_type: 'MODEL_CONVERSION', job_id: id, assignment_token: assignmentToken,
        configuration_snapshot: snapshot as Record<string, unknown>, configuration_hash: configHash,
        correlation_id: correlationId,
      }).returning('id').executeTakeFirstOrThrow();

      await this.outboxService.enqueue({
        eventType: DISPATCH_EVENT, aggregateTypeCode: 'JOB_EXECUTION', aggregateId: jobExecutionId,
        payload: {
          job_execution_id: jobExecutionId, assignment_token: assignmentToken, job_type: 'MODEL_CONVERSION',
          conversion_id: id, model_id: modelId, correlation_id: correlationId, attempt_number: 1,
        } as Record<string, unknown>,
        correlationId,
      }, trx);

      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id, actionCode: 'MODEL_CONVERSION_CREATED',
        resourceTypeCode: 'MODEL_CONVERSION', resourceId: id, result: 'SUCCESS', correlationId,
        metadata: { model_id: modelId, args: hp },
      }, trx);

      const row = await trx.selectFrom('model_conversions').select(FIELDS).where('id', '=', id).executeTakeFirstOrThrow();
      return { ...row, job_execution_id: jobExecutionId };
    });
  }

  async list(modelId: string) {
    const rows = await this.db.selectFrom('model_conversions as c')
      .leftJoin('artifacts as a', 'a.id', 'c.artifact_id')
      .leftJoin('job_executions as je', (join) =>
        join.onRef('je.job_id', '=', 'c.id').on('je.job_type', '=', 'MODEL_CONVERSION'))
      .select([
        'c.id', 'c.model_id', 'c.status', 'c.args', 'c.artifact_id', 'c.failure_code', 'c.failure_message',
        'c.requested_by_user_id', 'c.created_at', 'c.started_at', 'c.finished_at', 'c.row_version',
        'a.filename as artifact_filename', 'a.file_size_bytes as artifact_size',
        'je.id as job_execution_id',
      ])
      .where('c.model_id', '=', modelId)
      .orderBy('c.created_at', 'desc')
      .execute();
    return rows;
  }

  async get(modelId: string, conversionId: string) {
    const row = await this.db.selectFrom('model_conversions as c')
      .leftJoin('artifacts as a', 'a.id', 'c.artifact_id')
      .select([
        'c.id', 'c.model_id', 'c.status', 'c.args', 'c.artifact_id', 'c.failure_code', 'c.failure_message',
        'c.requested_by_user_id', 'c.created_at', 'c.started_at', 'c.finished_at', 'c.row_version',
        'a.filename as artifact_filename', 'a.file_size_bytes as artifact_size',
      ])
      .where('c.id', '=', conversionId)
      .executeTakeFirst();
    if (!row || row.model_id !== modelId) {
      throw err(errorCode.MODEL_CONVERSION_NOT_FOUND, 'model conversion not found', 404);
    }
    return row;
  }

  /**
   * Local exception to the "artifacts are immutable" rule (see AGENTS.md): unlike a
   * training result, an OpenVINO export is trivially reproducible by re-running the
   * conversion, so admins may hard-delete it (MinIO object + artifacts row + the
   * conversion record itself). No other artifact type gets this treatment.
   */
  async remove(modelId: string, conversionId: string, actor: Actor) {
    const correlationId = randomUUID();
    const objectKey: { bucket: string; key: string } | null = await this.db.transaction().execute(async (trx) => {
      let ok: { bucket: string; key: string } | null = null;
      const row = await trx.selectFrom('model_conversions')
        .select(['id', 'model_id', 'status', 'artifact_id'])
        .where('id', '=', conversionId)
        .executeTakeFirst();
      if (!row || row.model_id !== modelId) {
        throw err(errorCode.MODEL_CONVERSION_NOT_FOUND, 'model conversion not found', 404);
      }
      if (row.status === 'QUEUED' || row.status === 'RUNNING') {
        throw err(errorCode.MODEL_CONVERSION_NOT_DELETABLE, `cannot delete a conversion that is ${row.status}`, 409);
      }

      if (row.artifact_id) {
        const a = await trx.selectFrom('artifacts')
          .select(['bucket_name', 'object_key'])
          .where('id', '=', row.artifact_id)
          .executeTakeFirst();
        if (a) ok = { bucket: a.bucket_name, key: a.object_key };
        await trx.deleteFrom('artifacts').where('id', '=', row.artifact_id).execute();
      }
      await trx.deleteFrom('model_conversions').where('id', '=', conversionId).execute();

      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id, actionCode: 'MODEL_CONVERSION_ARTIFACT_DELETED',
        resourceTypeCode: 'MODEL_CONVERSION', resourceId: conversionId, result: 'SUCCESS', correlationId,
        metadata: { model_id: modelId, artifact_id: row.artifact_id },
      }, trx);

      return ok;
    });

    // Physical delete happens after the DB commit succeeds; if this fails the object
    // is orphaned in MinIO (safe to ignore — no DB row points at it anymore).
    if (objectKey) await this.minio.removeObject(objectKey.bucket, objectKey.key);
  }
}
