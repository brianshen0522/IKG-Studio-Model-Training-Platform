import { Inject, Injectable, HttpException } from '@nestjs/common';
import { DB_PROVIDER } from '../database/database.module';
import { type Kysely, sql } from 'kysely';
import type { Database, DatasetTaskType, TrainingDatasetOrigin } from '@model-trainer/db';
import { errorCode } from '@model-trainer/shared-types';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { createHash, randomUUID } from 'crypto';
import { normalizeRoot, rootRelation, isWithinRoot } from '../common/roots';
import * as fs from 'fs';
import * as path from 'path';

const PHASE1_TASK_TYPES: DatasetTaskType[] = ['DETECT', 'OBB'];
const BUILD_EVENT = 'job.dataset_build.dispatch';
const VALIDATE_EVENT = 'job.training_dataset_scan.dispatch';
const DELETE_EVENT = 'job.training_dataset_delete.dispatch';
const SPLIT_STRATEGIES = ['RANDOM', 'SAME'] as const;
const STORAGE_MODES = ['COPY', 'HARDLINK'] as const;
const ORIGINS: TrainingDatasetOrigin[] = ['BUILT', 'REGISTERED'];
const NAME_RE = /^[a-zA-Z0-9_-]{1,255}$/;
const BUILDER_VERSION = 1;
const TARGET_NAMING_VERSION = 1;

type Actor = { id: string; role: string };
type Exec = Kysely<Database>;
const err = (code: string, message: string, status: number, details?: Record<string, unknown>) =>
  new HttpException({ error: { code, message, details, requestId: '' } }, status);

/** Rejects absolute paths and any traversal segment; the worker re-checks for symlinks. */
function validRelPath(p: string): boolean {
  if (!p || p.includes('\0') || p.startsWith('/')) return false;
  return !p.split('/').some((seg) => seg === '..');
}

const FIELDS = [
  'id', 'name', 'description', 'dataset_type_id', 'task_type', 'origin', 'status',
  'source_dataset_ids', 'version_number', 'split_strategy', 'random_seed',
  'train_ratio', 'val_ratio', 'test_ratio', 'storage_mode',
  'train_count', 'val_count', 'test_count', 'class_count', 'classes_hash', 'configuration_hash',
  'data_yaml_artifact_id', 'manifest_artifact_id', 'build_job_id',
  'failure_code', 'failure_message', 'build_started_at', 'build_finished_at',
  'ready_at', 'same_split_targets', 'relative_path',
  'row_version', 'created_at', 'created_by_user_id', 'updated_at', 'archived_at',
] as const;

const LIST_FIELDS = [
  'id', 'name', 'description', 'dataset_type_id', 'task_type', 'origin', 'status',
  'version_number', 'train_count', 'val_count', 'test_count', 'class_count',
  'source_dataset_ids', 'split_strategy', 'storage_mode', 'relative_path',
  'created_at', 'created_by_user_id', 'updated_at', 'ready_at', 'archived_at',
] as const;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

const INFERRED = /^class_\d+$/;

/**
 * A Training Dataset is whatever a training job or benchmark can point at: a directory
 * holding data.yaml plus train/val(/test) splits. It arrives one of two ways (migration 055):
 *
 *   origin='BUILT'      — the platform merges READY source datasets, computes the split,
 *                         copies pairs and writes data.yaml under the dataset type's
 *                         training_dataset_path.
 *   origin='REGISTERED' — the directory already exists (prepared elsewhere); the scan only
 *                         validates data.yaml, counts splits, and checks the labels match
 *                         the declared task_type.
 */
@Injectable()
export class TrainingDatasetsService {
  constructor(
    @Inject(DB_PROVIDER) private readonly db: Kysely<Database>,
    private readonly auditService: AuditService,
    private readonly outboxService: OutboxService,
  ) {}

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
      throw err(errorCode.SOURCE_DATASET_DATASET_TYPE_INVALID, 'dataset type not found or disabled', 400);
    }
  }

  /** Training datasets live under the type's training_dataset_path; it has to be configured. */
  private async assertTrainingDatasetPath(exec: Exec, datasetTypeId: string) {
    const dt = await exec.selectFrom('dataset_types')
      .select(['id', 'training_dataset_path'])
      .where('id', '=', datasetTypeId).executeTakeFirst();
    if (!dt) throw err(errorCode.DATASET_TYPE_NOT_FOUND, 'dataset type not found', 404);
    if (!dt.training_dataset_path) {
      throw err(errorCode.TRAINING_DATASET_PATH_INVALID,
        'dataset type has no training_dataset_path configured', 400);
    }
    return dt.training_dataset_path;
  }

  /**
   * A REGISTERED dataset points at a directory the admin picked. Training roots are
   * allowed to nest (one type's root can live under another's), so a path that is legal
   * relative to this type's root may still sit inside a *deeper* type's root — the
   * directory then belongs to that type, and registering it here would file the same
   * directory under two types. The browser hides those subtrees; this is the check that
   * actually holds, since relative_path can be typed in directly.
   */
  private async assertNotInsideAnotherTypesRoot(
    exec: Exec, datasetTypeId: string, root: string, relativePath: string,
  ) {
    const target = normalizeRoot(`${normalizeRoot(root)}/${relativePath}`);
    const others = await exec.selectFrom('dataset_types')
      .select(['id', 'name', 'training_dataset_path'])
      .where('id', '!=', datasetTypeId)
      .where('training_dataset_path', 'is not', null)
      .execute();

    for (const other of others) {
      const theirs = other.training_dataset_path as string;
      // Only a deeper root takes precedence; a root that merely encloses this type's
      // root does not own what lives under the more specific one.
      if (rootRelation(theirs, root) !== 'inside') continue;
      if (isWithinRoot(target, theirs)) {
        throw err(errorCode.TRAINING_DATASET_PATH_INVALID,
          `relative_path points inside the training dataset root of dataset type "${other.name}" ` +
          `(${theirs}). Register it under that dataset type instead.`,
          400, { conflicting_dataset_type_id: other.id, resolved_path: target });
      }
    }
  }

  // ── Create ──────────────────────────────────────────────────────────────────
  async create(
    input: {
      name: string;
      description?: string | null;
      dataset_type_id: string;
      task_type: DatasetTaskType;
      origin?: TrainingDatasetOrigin;
      relative_path?: string | null;
    },
    actor: Actor,
  ) {
    const origin: TrainingDatasetOrigin = input.origin ?? 'BUILT';
    if (!ORIGINS.includes(origin)) {
      throw err(errorCode.VALIDATION_FAILED, `origin must be one of ${ORIGINS.join(',')}`, 400);
    }
    if (!PHASE1_TASK_TYPES.includes(input.task_type)) {
      throw err(errorCode.VALIDATION_FAILED, 'task_type must be DETECT or OBB in phase 1', 400);
    }
    // The name becomes part of the on-disk target directory, so it stays path-safe.
    if (!NAME_RE.test(input.name)) {
      throw err(errorCode.TRAINING_DATASET_NAME_INVALID,
        'name must be 1-255 chars of letters, digits, underscore or hyphen', 400);
    }
    if (origin === 'REGISTERED' && (!input.relative_path || !validRelPath(input.relative_path))) {
      throw err(errorCode.TRAINING_DATASET_PATH_INVALID,
        'relative_path is required for a registered dataset and must stay inside the type root', 400);
    }

    const correlationId = randomUUID();
    return this.db.transaction().execute(async (trx) => {
      await this.assertDatasetTypeUsable(trx, input.dataset_type_id);
      if (origin === 'REGISTERED') {
        const root = await this.assertTrainingDatasetPath(trx, input.dataset_type_id);
        await this.assertNotInsideAnotherTypesRoot(
          trx, input.dataset_type_id, root, input.relative_path!,
        );
      }

      const dup = await trx.selectFrom('training_datasets').select('id')
        .where('dataset_type_id', '=', input.dataset_type_id)
        .where('name', '=', input.name)
        .where('archived_at', 'is', null).executeTakeFirst();
      if (dup) {
        throw err(errorCode.DATASET_NAME_ALREADY_EXISTS,
          'a training dataset with this name already exists for this dataset type', 409);
      }

      const { id } = await trx.insertInto('training_datasets').values({
        name: input.name,
        description: input.description ?? null,
        dataset_type_id: input.dataset_type_id,
        task_type: input.task_type,
        origin,
        status: 'DRAFT',
        relative_path: origin === 'REGISTERED' ? input.relative_path! : null,
        created_by_user_id: actor.id,
        updated_by_user_id: actor.id,
      }).returning('id').executeTakeFirstOrThrow();

      const row = await trx.selectFrom('training_datasets').select(FIELDS)
        .where('id', '=', id).executeTakeFirstOrThrow();
      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id, actionCode: 'TRAINING_DATASET_CREATED',
        resourceTypeCode: 'TRAINING_DATASET', resourceId: id, result: 'SUCCESS', correlationId,
        afterSnapshot: row as unknown as Record<string, unknown>,
      }, trx);
      return row;
    });
  }

  /** Live uniqueness check for the wizard Details step — same rule as create()'s dup guard. */
  async nameAvailable(name: string, datasetTypeId: string) {
    if (!NAME_RE.test(name)) return { available: false };
    const dup = await this.db.selectFrom('training_datasets').select('id')
      .where('dataset_type_id', '=', datasetTypeId)
      .where('name', '=', name)
      .where('archived_at', 'is', null).executeTakeFirst();
    return { available: !dup };
  }

  async list(params: {
    page: number; size: number;
    dataset_type_id?: string; task_type?: string; origin?: string; archived?: boolean;
  }) {
    const size = Math.min(Math.max(params.size, 1), 100);
    const offset = (params.page - 1) * size;
    let q = this.db.selectFrom('training_datasets');
    if (params.dataset_type_id) q = q.where('dataset_type_id', '=', params.dataset_type_id);
    if (params.task_type) q = q.where('task_type', '=', params.task_type as DatasetTaskType);
    if (params.origin) q = q.where('origin', '=', params.origin as TrainingDatasetOrigin);
    if (!params.archived) q = q.where('status', '!=', 'DELETED');
    const [{ count }] = await q.select(sql<number>`count(*)`.as('count')).execute();
    const items = await q.select(LIST_FIELDS).orderBy('created_at', 'desc').limit(size).offset(offset).execute();
    return { items, total: Number(count), page: params.page, size };
  }

  async get(id: string) {
    const row = await this.db.selectFrom('training_datasets').select(FIELDS).where('id', '=', id).executeTakeFirst();
    if (!row) throw err(errorCode.TRAINING_DATASET_NOT_FOUND, 'training dataset not found', 404);
    const sources = await this.getSources(id);
    const classes = await this.getClasses(id);
    return { ...row, sources, classes };
  }

  /** What deleting this dataset would leave dangling — shown in the delete confirmation. */
  async associations(id: string) {
    const ds = await this.db.selectFrom('training_datasets').select('id').where('id', '=', id).executeTakeFirst();
    if (!ds) throw err(errorCode.TRAINING_DATASET_NOT_FOUND, 'training dataset not found', 404);
    const [jobs, benchmarkDatasets, benchmarkEvals] = await Promise.all([
      this.db.selectFrom('training_jobs').select(['id', 'name']).where('training_dataset_id', '=', id).execute(),
      this.db.selectFrom('benchmark_run_datasets').select('benchmark_run_id').where('training_dataset_id', '=', id).execute(),
      this.db.selectFrom('benchmark_evaluations').select('id').where('training_dataset_id', '=', id).execute(),
    ]);
    return {
      training_jobs: jobs,
      benchmark_run_ids: [...new Set(benchmarkDatasets.map((b) => b.benchmark_run_id))],
      benchmark_evaluation_count: benchmarkEvals.length,
    };
  }

  /**
   * Local exception to the "artifacts are immutable" rule (see AGENTS.md), same shape as
   * ModelsService.deleteModel: soft-delete (status='DELETED', row kept) so
   * training_jobs.training_dataset_id and benchmark rows that reference it keep
   * resolving. Disk cleanup only happens for origin='BUILT' — that directory is the
   * platform's own copy under the dataset type's training_dataset_path. origin='REGISTERED'
   * points at a directory the admin prepared elsewhere, so this only unregisters it; the
   * directory itself is left alone, same spirit as source datasets being read-only.
   */
  async deleteDataset(id: string, actor: Actor) {
    const correlationId = randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const ds = await trx.selectFrom('training_datasets').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!ds) throw err(errorCode.TRAINING_DATASET_NOT_FOUND, 'training dataset not found', 404);
      if (ds.status === 'DELETED') throw err(errorCode.TRAINING_DATASET_ALREADY_DELETED, 'already deleted', 409);
      if (ds.status === 'BUILDING' || ds.status === 'VALIDATING') {
        throw err(errorCode.TRAINING_DATASET_ALREADY_RUNNING,
          `cannot delete while ${ds.status.toLowerCase()}`, 409);
      }

      await trx.updateTable('training_datasets')
        .set({
          status: 'DELETED', archived_at: sql`now()`, updated_at: sql`now()`,
          updated_by_user_id: actor.id, row_version: (ds.row_version as number) + 1,
        })
        .where('id', '=', id).execute();

      if (ds.origin === 'BUILT') {
        await this.outboxService.enqueue({
          eventType: DELETE_EVENT, aggregateTypeCode: 'TRAINING_DATASET', aggregateId: id,
          payload: { dataset_id: id, correlation_id: correlationId } as Record<string, unknown>,
          correlationId,
        }, trx);
      }

      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id, actionCode: 'TRAINING_DATASET_DELETED',
        resourceTypeCode: 'TRAINING_DATASET', resourceId: id, result: 'SUCCESS', correlationId,
        beforeSnapshot: { status: ds.status },
        metadata: { origin: ds.origin, disk_cleanup_dispatched: ds.origin === 'BUILT' },
      }, trx);
      return { id, status: 'DELETED' as const };
    });
  }

  // ── Build config (origin=BUILT only) ────────────────────────────────────────
  async configureBuild(
    datasetId: string,
    input: {
      source_dataset_ids: string[];
      split: { strategy: string; train_ratio?: number; val_ratio?: number; test_ratio?: number; random_seed?: number };
      storage_mode?: string;
      class_names_override?: string[] | null;
      same_split_targets?: string[];
      same_split_warning_acknowledged?: boolean;
    },
    actor: Actor,
  ) {
    const sourceIds = [...new Set(input.source_dataset_ids ?? [])];
    if (sourceIds.length === 0) throw err(errorCode.DATASET_NO_SOURCES, 'at least one source dataset is required', 400);
    const strategy = input.split?.strategy;
    if (!strategy || !(SPLIT_STRATEGIES as readonly string[]).includes(strategy)) {
      throw err(errorCode.DATASET_SPLIT_INVALID, 'split.strategy must be RANDOM or SAME in phase 1', 400);
    }
    const storageMode = input.storage_mode ?? 'COPY';
    if (!(STORAGE_MODES as readonly string[]).includes(storageMode)) {
      throw err(errorCode.DATASET_HARDLINK_NOT_ALLOWED, `storage_mode must be one of ${STORAGE_MODES.join(',')}`, 400);
    }

    let train = 1, val = 0, test = 0, seed: number | null = null;
    let sameTargets: string[] | null = null;
    if (strategy === 'RANDOM') {
      train = input.split.train_ratio ?? 0; val = input.split.val_ratio ?? 0; test = input.split.test_ratio ?? 0;
      seed = input.split.random_seed ?? 42;
      if (train <= 0 || val < 0 || test < 0 || Math.abs(train + val + test - 1) > 1e-5) {
        throw err(errorCode.DATASET_SPLIT_INVALID, 'ratios must be >=0, train>0, and sum to 1', 400);
      }
    } else {
      if (!input.same_split_warning_acknowledged) {
        throw err(errorCode.DATASET_SAME_SPLIT_CONFIRMATION_REQUIRED, 'same_split_warning_acknowledged must be true for SAME split', 400);
      }
      // "No split" always feeds every image to all three splits; any client-sent
      // target list is a leftover of the old picker and is ignored.
      sameTargets = ['train', 'val', 'test'];
    }

    const correlationId = randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const ds = await trx.selectFrom('training_datasets').selectAll().where('id', '=', datasetId).forUpdate().executeTakeFirst();
      if (!ds) throw err(errorCode.TRAINING_DATASET_NOT_FOUND, 'training dataset not found', 404);
      if (ds.origin !== 'BUILT') {
        throw err(errorCode.TRAINING_DATASET_ORIGIN_MISMATCH,
          'build configuration only applies to datasets built from source datasets', 409);
      }
      if (ds.archived_at) throw err(errorCode.TRAINING_DATASET_ARCHIVED, 'training dataset is archived', 409);
      if (ds.status === 'BUILDING') throw err(errorCode.DATASET_VERSION_ALREADY_BUILDING, 'build already in progress', 409);

      const classMerge = new Map<number, string>();
      for (const sid of sourceIds) {
        const sd = await trx.selectFrom('source_datasets').selectAll().where('id', '=', sid).executeTakeFirst();
        if (!sd) throw err(errorCode.SOURCE_DATASET_NOT_FOUND, `source dataset ${sid} not found`, 404);
        if (sd.archived_at) throw err(errorCode.SOURCE_DATASET_ALREADY_ARCHIVED, `source dataset ${sid} is archived`, 409);
        if (sd.status !== 'READY' || !sd.latest_scan_id) throw err(errorCode.SOURCE_DATASET_NOT_READY, `source dataset ${sid} is not READY`, 409);
        if (sd.dataset_type_id !== ds.dataset_type_id) throw err(errorCode.DATASET_TYPE_MISMATCH, 'all sources must share the dataset type', 400);
        if (sd.task_type !== ds.task_type) throw err(errorCode.DATASET_TASK_TYPE_MISMATCH, 'all sources must share the task type', 400);

        const classRows = await trx.selectFrom('source_dataset_classes').select(['class_index', 'class_name'])
          .where('scan_id', '=', sd.latest_scan_id).orderBy('class_index').execute();
        for (const c of classRows) {
          const existing = classMerge.get(c.class_index);
          if (existing !== undefined && existing !== c.class_name) {
            throw err(errorCode.DATASET_CLASS_MISMATCH,
              `class index ${c.class_index}: '${existing}' vs '${c.class_name}' — cannot merge`, 400);
          }
          classMerge.set(c.class_index, c.class_name);
        }
      }
      const resolvedNames = [...classMerge.entries()].sort((a, b) => a[0] - b[0]).map(([_, n]) => n);
      if (resolvedNames.length === 0) throw err(errorCode.DATASET_CLASS_MISMATCH, 'sources have no classes', 400);

      let classNames = resolvedNames;
      if (input.class_names_override && input.class_names_override.length) {
        const ov = input.class_names_override.map((n) => n.trim());
        if (!resolvedNames.every((n) => INFERRED.test(n))) {
          throw err(errorCode.DATASET_CLASS_OVERRIDE_INVALID, 'override only allowed when source classes are inferred placeholders', 400);
        }
        if (ov.length !== resolvedNames.length) throw err(errorCode.DATASET_CLASS_OVERRIDE_INVALID, 'override count must match class count', 400);
        if (ov.some((n) => !n)) throw err(errorCode.DATASET_CLASS_OVERRIDE_INVALID, 'override names must be non-empty', 400);
        if (new Set(ov).size !== ov.length) throw err(errorCode.DATASET_CLASS_OVERRIDE_INVALID, 'override names must be unique', 400);
        classNames = ov;
      }

      const classHash = createHash('sha256').update(classNames.map((n, i) => `${i}:${n}`).join('\n')).digest('hex');

      await trx.updateTable('training_datasets').set({
        source_dataset_ids: sourceIds,
        split_strategy: strategy,
        random_seed: seed,
        train_ratio: train,
        val_ratio: val,
        test_ratio: test,
        storage_mode: storageMode,
        classes_hash: classHash,
        class_count: classNames.length,
        same_split_targets: sameTargets ? JSON.stringify(sameTargets) : null,
        status: 'DRAFT',
        updated_at: sql`now()`,
        updated_by_user_id: actor.id,
        row_version: sql`row_version + 1`,
      }).where('id', '=', datasetId).execute();

      const row = await trx.selectFrom('training_datasets').select(FIELDS).where('id', '=', datasetId).executeTakeFirstOrThrow();
      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id, actionCode: 'TRAINING_DATASET_BUILD_CONFIGURED',
        resourceTypeCode: 'TRAINING_DATASET', resourceId: datasetId, result: 'SUCCESS', correlationId,
        afterSnapshot: { source_dataset_ids: sourceIds, strategy, storage_mode: storageMode },
      }, trx);
      return row;
    });
  }

  // ── Submit ──────────────────────────────────────────────────────────────────
  /**
   * Hands the dataset to the dataset-worker: BUILT gets a full build job, REGISTERED gets
   * a validation scan. Both are user-initiated — a scheduler that polled for DRAFT rows
   * would re-dispatch the same row on every tick, since nothing else moves it off DRAFT.
   */
  async submit(datasetId: string, actor: Actor) {
    const correlationId = randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const ds = await trx.selectFrom('training_datasets').selectAll().where('id', '=', datasetId).forUpdate().executeTakeFirst();
      if (!ds) throw err(errorCode.TRAINING_DATASET_NOT_FOUND, 'training dataset not found', 404);
      if (ds.archived_at) throw err(errorCode.TRAINING_DATASET_ARCHIVED, 'training dataset is archived', 409);
      if (ds.status === 'BUILDING' || ds.status === 'VALIDATING') {
        throw err(errorCode.TRAINING_DATASET_ALREADY_RUNNING, `already ${ds.status.toLowerCase()}`, 409);
      }
      if (ds.status !== 'DRAFT' && ds.status !== 'INVALID') {
        throw err(errorCode.DATASET_VERSION_NOT_EDITABLE,
          `training dataset is ${ds.status}; only DRAFT or INVALID can be submitted`, 409);
      }

      const registered = ds.origin === 'REGISTERED';
      const sourceIds = (ds.source_dataset_ids ?? []) as string[];

      if (registered) {
        await this.assertTrainingDatasetPath(trx, ds.dataset_type_id);
      } else {
        if (sourceIds.length === 0) throw err(errorCode.DATASET_NO_SOURCES, 'no source datasets configured', 400);
        for (const sid of sourceIds) {
          const sd = await trx.selectFrom('source_datasets').select(['id', 'latest_scan_id']).where('id', '=', sid).executeTakeFirst();
          if (!sd || !sd.latest_scan_id) throw err(errorCode.SOURCE_DATASET_NOT_READY, `source ${sid} has no scan`, 409);
          const scan = await trx.selectFrom('source_dataset_scans').select(['status']).where('id', '=', sd.latest_scan_id).executeTakeFirst();
          if (!scan || scan.status !== 'COMPLETED') throw err(errorCode.SOURCE_DATASET_NOT_READY, `source ${sid} scan not COMPLETED`, 409);
        }
      }

      const configHash = createHash('sha256').update(canonical({
        dataset_id: datasetId, origin: ds.origin, task_type: ds.task_type,
        relative_path: ds.relative_path, storage_mode: ds.storage_mode,
        split_strategy: ds.split_strategy, train_ratio: Number(ds.train_ratio), val_ratio: Number(ds.val_ratio),
        test_ratio: Number(ds.test_ratio), random_seed: ds.random_seed, same_split_targets: ds.same_split_targets,
        classes_hash: ds.classes_hash, sources: sourceIds,
        target_naming_version: TARGET_NAMING_VERSION, builder_version: BUILDER_VERSION,
      })).digest('hex');

      const jobType = registered ? 'TRAINING_DATASET_SCAN' : 'DATASET_BUILD';
      const lastExecution = await trx.selectFrom('job_executions')
        .select('attempt_number').where('job_type', '=', jobType).where('job_id', '=', datasetId)
        .orderBy('attempt_number', 'desc').limit(1).executeTakeFirst();
      const attemptNumber = (lastExecution?.attempt_number ?? 0) + 1;
      const assignmentToken = randomUUID();
      const { id: jobExecutionId } = await trx.insertInto('job_executions').values({
        job_type: jobType, job_id: datasetId, attempt_number: attemptNumber, assignment_token: assignmentToken,
        configuration_snapshot: { training_dataset_id: datasetId, origin: ds.origin } as Record<string, unknown>,
        configuration_hash: configHash,
        correlation_id: correlationId,
      }).returning('id').executeTakeFirstOrThrow();

      const nextStatus = registered ? 'VALIDATING' : 'BUILDING';
      await trx.updateTable('training_datasets').set({
        status: nextStatus, configuration_hash: configHash, build_job_id: jobExecutionId,
        build_started_at: sql`now()`, failure_code: null, failure_message: null,
        updated_at: sql`now()`, row_version: sql`row_version + 1`,
      }).where('id', '=', datasetId).execute();

      await this.outboxService.enqueue({
        eventType: registered ? VALIDATE_EVENT : BUILD_EVENT,
        aggregateTypeCode: 'JOB_EXECUTION', aggregateId: jobExecutionId,
        payload: {
          job_execution_id: jobExecutionId, assignment_token: assignmentToken, job_type: jobType,
          training_dataset_id: datasetId, correlation_id: correlationId, attempt_number: attemptNumber,
        } as Record<string, unknown>,
        correlationId,
      }, trx);

      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id,
        actionCode: registered ? 'TRAINING_DATASET_VALIDATION_SUBMITTED' : 'TRAINING_DATASET_BUILD_SUBMITTED',
        resourceTypeCode: 'TRAINING_DATASET', resourceId: datasetId, result: 'SUCCESS', correlationId,
        metadata: { job_execution_id: jobExecutionId, configuration_hash: configHash, origin: ds.origin },
      }, trx);

      return { id: datasetId, status: nextStatus, build_job_id: jobExecutionId };
    });
  }

  // ── Read helpers ────────────────────────────────────────────────────────────
  async getSources(datasetId: string) {
    const ds = await this.db.selectFrom('training_datasets').select(['id', 'source_dataset_ids'])
      .where('id', '=', datasetId).executeTakeFirst();
    if (!ds) throw err(errorCode.TRAINING_DATASET_NOT_FOUND, 'training dataset not found', 404);
    const sourceIds = (ds.source_dataset_ids ?? []) as string[];
    if (!sourceIds.length) return [];
    return this.db.selectFrom('source_datasets')
      .select(['id', 'name', 'relative_path', 'task_type', 'status'])
      .where('id', 'in', sourceIds)
      .execute();
  }

  /**
   * Class list for a BUILT dataset, merged from its sources' latest scans. A REGISTERED
   * dataset has no source scans — its classes live in data.yaml, so only the count and
   * hash recorded by the validation scan are available.
   */
  async getClasses(datasetId: string) {
    const ds = await this.db.selectFrom('training_datasets').select(['id', 'source_dataset_ids'])
      .where('id', '=', datasetId).executeTakeFirst();
    if (!ds || !ds.source_dataset_ids || (ds.source_dataset_ids as string[]).length === 0) return [];
    const sourceIds = ds.source_dataset_ids as string[];

    const sd = await this.db.selectFrom('source_datasets')
      .select(['latest_scan_id']).where('id', 'in', sourceIds).where('latest_scan_id', 'is not', null)
      .execute();
    const scanIds = sd.map((s) => s.latest_scan_id!).filter(Boolean);
    if (!scanIds.length) return [];

    const allClasses = await this.db.selectFrom('source_dataset_classes')
      .select(['class_index', 'class_name'])
      .where('scan_id', 'in', scanIds)
      .orderBy('class_index')
      .execute();

    const merged = new Map<number, string>();
    for (const c of allClasses) {
      if (!merged.has(c.class_index)) merged.set(c.class_index, c.class_name);
    }
    return [...merged.entries()].sort((a, b) => a[0] - b[0]).map(([index, name]) => ({ class_index: index, class_name: name }));
  }

  async getArtifacts(datasetId: string) {
    return this.db.selectFrom('artifacts')
      .select(['id', 'artifact_type_code', 'status', 'filename', 'object_key', 'file_size_bytes', 'checksum', 'created_at'])
      .where('owner_type_code', '=', 'TRAINING_DATASET').where('owner_id', '=', datasetId)
      .orderBy('created_at').execute();
  }

  // ── Sample preview (READY datasets only) ───────────────────────────────────
  private readonly SAFE_FILENAME = /^[a-zA-Z0-9._-]+$/;
  private readonly SPLITS = ['train', 'val', 'test'] as const;

  /** Resolves and validates the on-disk directory holding images/labels for a READY dataset. */
  private async resolveDatasetDir(datasetId: string) {
    const ds = await this.db.selectFrom('training_datasets')
      .select(['id', 'status', 'relative_path', 'dataset_type_id', 'task_type', 'split_strategy'])
      .where('id', '=', datasetId).executeTakeFirst();
    if (!ds) throw err(errorCode.TRAINING_DATASET_NOT_FOUND, 'training dataset not found', 404);
    if (ds.status !== 'READY' || !ds.relative_path) {
      throw err(errorCode.TRAINING_DATASET_PATH_INVALID, 'training dataset is not ready for preview', 409);
    }
    const dt = await this.db.selectFrom('dataset_types')
      .select(['training_dataset_path']).where('id', '=', ds.dataset_type_id).executeTakeFirst();
    if (!dt?.training_dataset_path) {
      throw err(errorCode.TRAINING_DATASET_PATH_INVALID, 'dataset type has no training_dataset_path configured', 400);
    }
    const root = normalizeRoot(dt.training_dataset_path);
    const dir = normalizeRoot(path.join(root, ds.relative_path));
    if (!isWithinRoot(dir, root)) {
      throw err(errorCode.TRAINING_DATASET_PATH_INVALID, 'resolved dataset path escapes its root', 400);
    }
    return { dir, taskType: ds.task_type, splitStrategy: ds.split_strategy };
  }

  /**
   * Splits to look in for a sample, in order. A SAME ("no split") build stores one
   * physical copy under train and aliases val/test to it in data.yaml, so those
   * splits fall back to the train directory. Older SAME builds that copied into
   * each split still hit their own directory first.
   */
  private splitCandidates(split: string, splitStrategy: unknown): string[] {
    if (!this.validSplit(split)) throw err(errorCode.VALIDATION_FAILED, 'split must be train, val or test', 400);
    return splitStrategy === 'SAME' && split !== 'train' ? [split, 'train'] : [split];
  }

  private validSplit(split: string): split is 'train' | 'val' | 'test' {
    return (this.SPLITS as readonly string[]).includes(split);
  }

  private resolveSampleFile(dir: string, kind: 'images' | 'labels', split: string, filename: string): string {
    if (!this.validSplit(split)) throw err(errorCode.VALIDATION_FAILED, 'split must be train, val or test', 400);
    if (!this.SAFE_FILENAME.test(filename)) throw err(errorCode.VALIDATION_FAILED, 'invalid filename', 400);
    const splitDir = normalizeRoot(path.join(dir, kind, split));
    if (!isWithinRoot(splitDir, dir)) throw err(errorCode.VALIDATION_FAILED, 'invalid split path', 400);
    const full = path.join(splitDir, filename);
    if (!isWithinRoot(normalizeRoot(full), splitDir)) throw err(errorCode.VALIDATION_FAILED, 'invalid filename', 400);
    return full;
  }

  async listSamples(datasetId: string, split: string, limit: number, offset: number) {
    const { dir, splitStrategy } = await this.resolveDatasetDir(datasetId);
    let entries: string[] = [];
    for (const s of this.splitCandidates(split, splitStrategy)) {
      const imagesDir = normalizeRoot(path.join(dir, 'images', s));
      try {
        entries = (await fs.promises.readdir(imagesDir, { withFileTypes: true }))
          .filter((e) => e.isFile() && !e.name.startsWith('.'))
          .map((e) => e.name)
          .sort();
        break;
      } catch {
        entries = [];
      }
    }
    return {
      files: entries.slice(offset, offset + limit),
      total: entries.length,
    };
  }

  async getSampleImagePath(datasetId: string, split: string, filename: string): Promise<string> {
    const { dir, splitStrategy } = await this.resolveDatasetDir(datasetId);
    for (const s of this.splitCandidates(split, splitStrategy)) {
      const full = this.resolveSampleFile(dir, 'images', s, filename);
      try {
        await fs.promises.access(full, fs.constants.R_OK);
        return full;
      } catch { /* try the next candidate */ }
    }
    throw err(errorCode.TRAINING_DATASET_NOT_FOUND, 'sample image not found', 404);
  }

  /**
   * Parses the YOLO label file paired with `filename` into boxes the browser can draw.
   * DETECT rows are `cls cx cy w h` (normalized), OBB rows are `cls x1 y1 x2 y2 x3 y3 x4 y4`.
   * Both may carry a trailing confidence column, which is dropped.
   */
  async getSampleLabels(datasetId: string, split: string, filename: string) {
    const { dir, taskType, splitStrategy } = await this.resolveDatasetDir(datasetId);
    const stem = filename.replace(/\.[^.]+$/, '');
    const labelFilename = `${stem}.txt`;

    let text: string | null = null;
    for (const s of this.splitCandidates(split, splitStrategy)) {
      const full = this.resolveSampleFile(dir, 'labels', s, labelFilename);
      try {
        text = await fs.promises.readFile(full, 'utf8');
        break;
      } catch { /* try the next candidate */ }
    }
    if (text === null) return { task_type: taskType, boxes: [] };

    const expected = taskType === 'OBB' ? 9 : 5;
    const boxes: Array<{ class_index: number; values: number[] }> = [];
    for (const line of text.split('\n')) {
      const fields = line.trim().split(/\s+/).filter(Boolean);
      if (fields.length === 0) continue;
      if (fields.length !== expected && fields.length !== expected + 1) continue;
      const nums = fields.slice(0, expected).map(Number);
      if (nums.some(Number.isNaN)) continue;
      boxes.push({ class_index: nums[0], values: nums.slice(1) });
    }
    return { task_type: taskType, boxes };
  }
}
