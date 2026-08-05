import { Inject, Injectable, HttpException } from '@nestjs/common';
import { DB_PROVIDER } from '../database/database.module';
import { type Kysely, type Transaction, sql } from 'kysely';
import type { Database, DatasetTaskType } from '@model-trainer/db';
import { errorCode } from '@model-trainer/shared-types';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { DatasetTypesTreeService } from '../admin/dataset-types/dataset-types-tree.service';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { normalizeRoot, isWithinRoot } from '../common/roots';
import { dispatchDirectoryReindex, isReindexRunning } from './reindex';

const PHASE1_TASK_TYPES: DatasetTaskType[] = ['DETECT', 'OBB'];
const DISPATCH_EVENT = 'job.dataset_scan.dispatch';

type Actor = { id: string; role: string };
type Exec = Kysely<Database>;

/**
 * Guess a folder's task type from its label geometry, for one-click registration where
 * the user is never asked. DETECT rows are `cls cx cy w h`, OBB rows are
 * `cls x1 y1 … x4 y4`; either may carry one extra trailing confidence column, which the
 * scanner accepts and the build strips.
 *
 * Returns null when nothing readable says either way — the caller picks the default.
 */
async function sniffTaskType(datasetDir: string): Promise<DatasetTaskType | null> {
  let files: string[];
  try {
    files = (await fs.promises.readdir(`${datasetDir}/labels`))
      .filter((f) => f.endsWith('.txt') && !f.startsWith('.'))
      .sort()
      .slice(0, 5);
  } catch {
    return null;
  }
  for (const f of files) {
    let text: string;
    try { text = await fs.promises.readFile(`${datasetDir}/labels/${f}`, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const n = line.trim().split(/\s+/).filter(Boolean).length;
      if (n === 5 || n === 6) return 'DETECT';
      if (n === 9 || n === 10) return 'OBB';
    }
  }
  return null;
}

const err = (code: string, message: string, status: number, details?: Record<string, unknown>) =>
  new HttpException({ error: { code, message, details, requestId: '' } }, status);

function validRelPath(p: string): boolean {
  if (!p || p.includes('\0') || p.startsWith('/')) return false;
  return !p.split('/').some((seg) => seg === '..');
}

const FIELDS = [
  'id', 'name', 'dataset_type_id', 'task_type', 'relative_path', 'sub_path',
  'images_relative_path', 'labels_relative_path', 'classes_file_relative_path',
  'allow_subdirectories', 'split_layout', 'notes', 'status', 'latest_scan_id',
  'row_version', 'created_at', 'created_by_user_id', 'updated_at', 'archived_at',
  'manual_classes_override',
] as const;

@Injectable()
export class SourceDatasetsService {
  constructor(
    @Inject(DB_PROVIDER) private readonly db: Kysely<Database>,
    private readonly auditService: AuditService,
    private readonly outboxService: OutboxService,
    private readonly tree: DatasetTypesTreeService,
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
    if (res.rows.length === 0 || res.rows[0].enabled === null) {
      throw err(errorCode.SOURCE_DATASET_DATASET_TYPE_INVALID, 'dataset type not found', 400);
    }
    if (!res.rows[0].enabled) {
      throw err(errorCode.SOURCE_DATASET_DATASET_TYPE_INVALID, 'dataset type is disabled', 400);
    }
  }

  private async dispatchScan(
    trx: Transaction<Database>, sourceDatasetId: string, scanVersion: number,
    actor: Actor, correlationId: string,
  ): Promise<{ scanId: string; jobExecutionId: string }> {
    const { id: scanId } = await trx.insertInto('source_dataset_scans')
      .values({ source_dataset_id: sourceDatasetId, scan_version: scanVersion, status: 'PENDING', created_by_user_id: actor.id })
      .returning('id').executeTakeFirstOrThrow();

    const assignmentToken = randomUUID();
    const snapshot = { source_dataset_id: sourceDatasetId, scan_id: scanId };
    const { id: jobExecutionId } = await trx.insertInto('job_executions')
      .values({
        job_type: 'DATASET_SCAN', job_id: scanId, assignment_token: assignmentToken,
        configuration_snapshot: snapshot as Record<string, unknown>,
        configuration_hash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
        correlation_id: correlationId,
      })
      .returning('id').executeTakeFirstOrThrow();

    await trx.updateTable('source_datasets')
      .set({ status: 'SCANNING', latest_scan_id: scanId, updated_at: sql`now()` })
      .where('id', '=', sourceDatasetId).execute();

    await this.outboxService.enqueue({
      eventType: DISPATCH_EVENT, aggregateTypeCode: 'JOB_EXECUTION', aggregateId: jobExecutionId,
      payload: {
        job_execution_id: jobExecutionId, assignment_token: assignmentToken, job_type: 'DATASET_SCAN',
        source_dataset_id: sourceDatasetId, scan_id: scanId, correlation_id: correlationId, attempt_number: 1,
      } as Record<string, unknown>,
      correlationId,
    }, trx);

    return { scanId, jobExecutionId };
  }

  async register(
    input: {
      name: string; dataset_type_id: string; task_type: DatasetTaskType;
      sub_path?: string | null;
      images_relative_path?: string; labels_relative_path?: string;
      classes_file_relative_path?: string | null; allow_subdirectories?: boolean;
      split_layout?: Record<string, unknown>; notes?: string | null;
    },
    actor: Actor,
  ) {
    if (!PHASE1_TASK_TYPES.includes(input.task_type)) {
      throw err(errorCode.VALIDATION_FAILED, 'task_type must be DETECT or OBB in phase 1', 400);
    }
    const imagesRel = input.images_relative_path ?? 'images';
    const labelsRel = input.labels_relative_path ?? 'labels';

    const correlationId = randomUUID();
    return this.db.transaction().execute(async (trx) => {
      await this.assertDatasetTypeUsable(trx, input.dataset_type_id);

      const effPath = await this.tree.effectiveBasePath(trx, input.dataset_type_id);
      if (!effPath) {
        throw err(errorCode.SOURCE_DATASET_DATASET_TYPE_INVALID, 'dataset type has no dataset_path (direct or inherited)', 400);
      }
      const subPath = (input.sub_path ?? '').trim() || input.name;
      if (!validRelPath(subPath)) {
        throw err(errorCode.DATASET_PATH_INVALID, `invalid sub_path: ${subPath}`, 400);
      }
      const relativePath = `${effPath.dataset_path}/${subPath}`;
      for (const p of [imagesRel, labelsRel, input.classes_file_relative_path].filter(Boolean) as string[]) {
        if (!validRelPath(p) && !p.startsWith('/')) {
          throw err(errorCode.DATASET_PATH_INVALID, `invalid path: ${p}`, 400);
        }
      }
      // One-click registration never sends a classes file — auto-detect the standard
      // Ultralytics <dataset_root>/classes.txt layout so scans use real class names
      // instead of falling back to index inference (which then flags every absent
      // class as a gap).
      let classesRel = input.classes_file_relative_path ?? null;
      if (classesRel === null) {
        try {
          if ((await fs.promises.stat(`${relativePath}/classes.txt`)).isFile()) {
            classesRel = 'classes.txt';
          }
        } catch {
          /* no classes.txt on disk */
        }
      }

      const dup = await trx.selectFrom('source_datasets').select('id')
        .where('dataset_type_id', '=', input.dataset_type_id)
        .where('sub_path', '=', subPath).executeTakeFirst();
      if (dup) throw err(errorCode.RESOURCE_CONFLICT, 'a source dataset already exists at this path', 409);

      const { id } = await trx.insertInto('source_datasets').values({
        name: input.name, dataset_type_id: input.dataset_type_id, task_type: input.task_type,
        relative_path: relativePath,
        sub_path: subPath,
        images_relative_path: imagesRel, labels_relative_path: labelsRel,
        classes_file_relative_path: classesRel,
        allow_subdirectories: input.allow_subdirectories ?? false,
        split_layout: (input.split_layout ?? {}) as Record<string, unknown>,
        notes: input.notes ?? null, status: 'REGISTERED',
        created_by_user_id: actor.id, updated_by_user_id: actor.id,
      }).returning('id').executeTakeFirstOrThrow();

      await this.dispatchScan(trx, id, 1, actor, correlationId);

      const row = await trx.selectFrom('source_datasets').select(FIELDS).where('id', '=', id).executeTakeFirstOrThrow();
      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id, actionCode: 'SOURCE_DATASET_CREATED',
        resourceTypeCode: 'SOURCE_DATASET', resourceId: id, result: 'SUCCESS', correlationId,
        afterSnapshot: row as unknown as Record<string, unknown>,
      }, trx);
      return row;
    });
  }

  async list(params: { page: number; size: number; dataset_type_id?: string; task_type?: string; status?: string; archived?: boolean }) {
    const size = Math.min(Math.max(params.size, 1), 100);
    const offset = (params.page - 1) * size;
    let base = this.db.selectFrom('source_datasets as sd');
    const apply = (q: typeof base) => {
      if (params.dataset_type_id) q = q.where('sd.dataset_type_id', '=', params.dataset_type_id);
      if (params.task_type) q = q.where('sd.task_type', '=', params.task_type as DatasetTaskType);
      if (params.status) q = q.where('sd.status', '=', params.status as never);
      if (!params.archived) q = q.where('sd.archived_at', 'is', null);
      return q;
    };
    const [{ count }] = await apply(base).select(sql<number>`count(*)`.as('count')).execute();
    const items = await apply(base)
      .leftJoin('source_dataset_scans as sc', 'sc.id', 'sd.latest_scan_id')
      .select([
        'sd.id', 'sd.name', 'sd.dataset_type_id', 'sd.task_type', 'sd.status', 'sd.relative_path',
        'sd.created_by_user_id', 'sd.created_at', 'sd.archived_at',
        'sc.image_count', 'sc.matched_pair_count', 'sc.class_count', 'sc.finished_at as last_scan_at',
      ])
      .orderBy('sd.created_at', 'desc').limit(size).offset(offset).execute();
    return { items, total: Number(count), page: params.page, size };
  }

  async findById(id: string) {
    const row = await this.db.selectFrom('source_datasets').select(FIELDS).where('id', '=', id).executeTakeFirst();
    if (!row) throw err(errorCode.SOURCE_DATASET_NOT_FOUND, 'source dataset not found', 404);
    let latestScan = null;
    if (row.latest_scan_id) {
      latestScan = await this.db.selectFrom('source_dataset_scans').selectAll().where('id', '=', row.latest_scan_id).executeTakeFirst();
    }
    return { ...row, latest_scan: latestScan ?? null };
  }

  /**
   * Auto-trigger a reindex the first time a type's index is queried empty (e.g. the
   * type was just created, or a manual DB wipe). Idempotent: the RUNNING-row check
   * inside dispatchDirectoryReindex means concurrent callers just no-op.
   */
  private async autoDispatchReindexIfEmpty(datasetTypeId: string): Promise<void> {
    const hasRows = await this.db.selectFrom('dataset_directory_index')
      .select('sub_path').where('dataset_type_id', '=', datasetTypeId).limit(1).executeTakeFirst();
    if (hasRows) return;
    try {
      await this.db.transaction().execute(async (trx) => {
        if (await isReindexRunning(trx, datasetTypeId)) return;
        await dispatchDirectoryReindex(this.outboxService, trx, datasetTypeId, randomUUID());
      });
    } catch {
      /* best-effort: a concurrent dispatch losing the race is fine, the other one runs */
    }
  }

  /**
   * Offer the dataset folders under this type's dataset_path that are not registered
   * yet. Reads the background-maintained index (`dataset_directory_index`) instead of
   * walking the (often CIFS-mounted) filesystem synchronously — see `rescanType` for
   * how the index gets refreshed.
   */
  async available(datasetTypeId: string) {
    await this.autoDispatchReindexIfEmpty(datasetTypeId);

    const entries = await this.db.selectFrom('dataset_directory_index')
      .select(['sub_path', 'image_count', 'label_count'])
      .where('dataset_type_id', '=', datasetTypeId)
      .execute();

    const existing = await this.db.selectFrom('source_datasets')
      .select(['id', 'sub_path'])
      .where('dataset_type_id', '=', datasetTypeId)
      .where('archived_at', 'is', null)
      .execute();
    const existingByPath = new Map(existing.map((r) => [r.sub_path || '', r]));

    return entries.map((e) => {
      const reg = existingByPath.get(e.sub_path);
      return {
        name: e.sub_path, path: e.sub_path, hasImages: true, hasLabels: true,
        imageCount: e.image_count, labelCount: e.label_count,
        isRegistered: !!reg, registeredId: reg?.id ?? null,
      };
    });
  }

  /**
   * Validate class compatibility across multiple source datasets.
   * Different class counts are OK (extra indices appended). Conflict = same index → different name.
   * Returns merged classes on success, or lists all conflicts.
   */
  async validateClasses(sourceDatasetIds: string[]) {
    if (sourceDatasetIds.length === 0) throw err(errorCode.VALIDATION_FAILED, 'at least one source dataset is required', 400);

    type SourceInfo = { id: string; name: string; status: string; scan_id: string | null; task_type: string; dataset_type_id: string };
    const sources: SourceInfo[] = [];
    let baseTypeId: string | null = null;
    let baseTaskType: string | null = null;

    for (const sid of [...new Set(sourceDatasetIds)]) {
      const sd = await this.db.selectFrom('source_datasets').selectAll().where('id', '=', sid).executeTakeFirst();
      if (!sd) throw err(errorCode.SOURCE_DATASET_NOT_FOUND, `source dataset ${sid} not found`, 404);
      if (sd.status !== 'READY' || !sd.latest_scan_id) throw err(errorCode.SOURCE_DATASET_NOT_READY, `source dataset ${sid} is not READY`, 409);
      if (baseTypeId === null) { baseTypeId = sd.dataset_type_id; baseTaskType = sd.task_type; }
      else if (sd.dataset_type_id !== baseTypeId) throw err(errorCode.DATASET_TYPE_MISMATCH, 'all sources must share the dataset type', 400);
      else if (sd.task_type !== baseTaskType) throw err(errorCode.DATASET_TASK_TYPE_MISMATCH, 'all sources must share the task type', 400);
      sources.push({ id: sd.id, name: sd.name, status: sd.status, scan_id: sd.latest_scan_id, task_type: sd.task_type, dataset_type_id: sd.dataset_type_id });
    }

    interface ClassInfo { class_index: number; class_name: string }
    interface ClassSource extends ClassInfo { source_dataset_id: string; source_name: string }

    type MergedEntry = { class_index: number; class_name: string; present_in_sources: string[] };
    const merged = new Map<number, MergedEntry>();
    const allRows: ClassSource[] = [];
    let totalImageCount = 0;

    for (const s of sources) {
      const rows = await this.db.selectFrom('source_dataset_classes')
        .select(['class_index', 'class_name'])
        .where('scan_id', '=', s.scan_id!)
        .orderBy('class_index').execute();
      for (const r of rows) {
        allRows.push({ ...r, source_dataset_id: s.id, source_name: s.name });
        const existing = merged.get(r.class_index);
        if (existing) {
          if (existing.class_name !== r.class_name) existing.class_name = ''; // mark conflict
          if (!existing.present_in_sources.includes(s.name)) existing.present_in_sources.push(s.name);
        } else {
          merged.set(r.class_index, {
            class_index: r.class_index,
            class_name: r.class_name,
            present_in_sources: [s.name],
          });
        }
      }
      // count images
      const scan = await this.db.selectFrom('source_dataset_scans')
        .select('image_count').where('id', '=', s.scan_id!).executeTakeFirst();
      totalImageCount += Number(scan?.image_count ?? 0);
    }

    const conflicts: Array<{ class_index: number; class_name_a: string; class_name_b: string; source_a: string; source_b: string }> = [];
    for (const [idx, entry] of merged) {
      if (entry.class_name === '') {
        // find the two differing opinions
        const rows = allRows.filter((r) => r.class_index === idx);
        const names = [...new Set(rows.map((r) => r.class_name))];
        for (let i = 1; i < rows.length; i++) {
          if (rows[i].class_name !== rows[0].class_name) {
            conflicts.push({
              class_index: idx,
              class_name_a: rows[0].class_name,
              class_name_b: rows[i].class_name,
              source_a: rows[0].source_name,
              source_b: rows[i].source_name,
            });
            break;
          }
        }
      }
    }

    // Fix merged entry class_name for conflict entries
    const mergedClasses: MergedEntry[] = [];
    for (const [idx, entry] of [...merged.entries()].sort((a, b) => a[0] - b[0])) {
      const conflict = conflicts.find((c) => c.class_index === idx);
      mergedClasses.push({ ...entry, class_name: conflict ? `CONFLICT: ${conflict.class_name_a} vs ${conflict.class_name_b}` : entry.class_name });
    }

    return {
      compatible: conflicts.length === 0,
      source_count: sources.length,
      total_image_count: totalImageCount,
      merged_classes: mergedClasses,
      conflicts,
    };
  }

  /**
   * DM-style browse: every dataset_path-having dataset type, with its on-disk folders
   * (dirs containing images/ + labels/) merged with registered source_datasets rows.
   * No manual registration — folders are auto-listed and grouped by type.
   *
   * Reads the background-maintained `dataset_directory_index` instead of walking the
   * (often CIFS-mounted) filesystem synchronously on every page load — the walk used to
   * take seconds per type and blocked this endpoint. See `rescanType` for how the index
   * gets refreshed, and `reindexing` on each group for whether one is in flight.
   */
  async browseByType() {
    const types = await this.db.selectFrom('dataset_types')
      .select(['id', 'name', 'icon', 'color', 'parent_id', 'enabled', 'dataset_path'])
      .where('dataset_path', 'is not', null)
      .execute();

    const registered = await this.db.selectFrom('source_datasets as sd')
      .leftJoin('source_dataset_scans as sc', 'sc.id', 'sd.latest_scan_id')
      .select([
        'sd.id', 'sd.dataset_type_id', 'sd.name', 'sd.sub_path', 'sd.task_type', 'sd.status',
        'sc.image_count', 'sc.matched_pair_count', 'sc.class_count', 'sc.finished_at as last_scan_at',
        'sc.classes_source',
      ])
      .where('sd.archived_at', 'is', null)
      .execute();
    const regByTypeSub = new Map<string, (typeof registered)[number]>();
    for (const r of registered) regByTypeSub.set(`${r.dataset_type_id}::${r.sub_path ?? ''}`, r);

    const index = await this.db.selectFrom('dataset_directory_index')
      .select(['dataset_type_id', 'sub_path', 'image_count']).execute();
    const indexByType = new Map<string, typeof index>();
    for (const row of index) {
      const list = indexByType.get(row.dataset_type_id);
      if (list) list.push(row); else indexByType.set(row.dataset_type_id, [row]);
    }

    const reindexes = await this.db.selectFrom('dataset_type_reindexes')
      .select(['dataset_type_id', 'status']).where('status', '=', 'RUNNING').execute();
    const runningSet = new Set(reindexes.map((r) => r.dataset_type_id));

    const groups: Array<{
      dataset_type_id: string; name: string;
      icon: string | null; color: string | null; dataset_path: string; inherited: boolean;
      reindexing: boolean;
      folders: Array<Record<string, unknown>>;
    }> = [];

    for (const t of types) {
      const eff = await this.tree.effectiveBasePath(this.db, t.id);
      if (!eff) continue;

      const found = indexByType.get(t.id) ?? [];
      if (found.length === 0 && !runningSet.has(t.id)) await this.autoDispatchReindexIfEmpty(t.id);

      const folders: Array<Record<string, unknown>> = found.map((row) => {
        const reg = regByTypeSub.get(`${t.id}::${row.sub_path}`) ?? null;
        return {
          sub_path: row.sub_path, path: `${eff.dataset_path}/${row.sub_path}`,
          image_count_on_disk: row.image_count,
          registered: !!reg,
          source_dataset_id: reg?.id ?? null,
          status: reg?.status ?? null,
          task_type: reg?.task_type ?? null,
          matched_pair_count: reg?.matched_pair_count ?? null,
          class_count: reg?.class_count ?? null,
          classes_source: reg?.classes_source ?? null,
          last_scan_at: reg?.last_scan_at ?? null,
        };
      });

      groups.push({
        dataset_type_id: t.id, name: t.name,
        icon: t.icon, color: t.color, dataset_path: eff.dataset_path, inherited: eff.inherited,
        reindexing: runningSet.has(t.id),
        folders,
      });
    }

    groups.sort((a, b) => a.name.localeCompare(b.name));
    return groups;
  }

  /**
   * Lazy register + scan a folder discovered under a dataset type's dataset_path.
   * Idempotent: if already registered (same type + sub_path), returns the existing row.
   */
  async ensure(input: { dataset_type_id: string; sub_path: string; task_type?: DatasetTaskType; name?: string }, actor: Actor) {
    if (!validRelPath(input.sub_path)) {
      throw err(errorCode.DATASET_PATH_INVALID, `invalid sub_path: ${input.sub_path}`, 400);
    }
    const existing = await this.db.selectFrom('source_datasets').select(FIELDS)
      .where('dataset_type_id', '=', input.dataset_type_id)
      .where('sub_path', '=', input.sub_path)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    if (existing) return existing;

    const name = input.name?.trim() || input.sub_path.split('/').pop() || input.sub_path;
    // One-click registration from the folder grid passes no task type, and guessing
    // wrong makes the scan fail on geometry. Read it off the labels instead.
    let taskType = input.task_type;
    if (!taskType) {
      const eff = await this.tree.effectiveBasePath(this.db, input.dataset_type_id);
      taskType = (eff ? await sniffTaskType(`${eff.dataset_path}/${input.sub_path}`) : null) ?? 'OBB';
    }
    return this.register({
      name, dataset_type_id: input.dataset_type_id,
      task_type: taskType, sub_path: input.sub_path,
    }, actor);
  }

  /**
   * Type-level rescan: dispatch a background reindex of the folder listing under this
   * type's dataset_path. Does NOT re-scan already-registered source datasets — each
   * folder keeps its own per-source Rescan button for that. This only refreshes which
   * folders exist / their image & label counts, so `browseByType`/`available` show
   * current disk state without a synchronous walk on every page load.
   */
  async rescanType(datasetTypeId: string, actor: Actor) {
    const correlationId = randomUUID();
    await this.assertDatasetTypeUsable(this.db, datasetTypeId);
    const eff = await this.tree.effectiveBasePath(this.db, datasetTypeId);
    if (!eff) throw err(errorCode.SOURCE_DATASET_DATASET_TYPE_INVALID, 'dataset type has no dataset_path (direct or inherited)', 400);

    await this.db.transaction().execute(async (trx) => {
      await dispatchDirectoryReindex(this.outboxService, trx, datasetTypeId, correlationId);
      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id, actionCode: 'DATASET_TYPE_REINDEX_REQUESTED',
        resourceTypeCode: 'DATASET_TYPE', resourceId: datasetTypeId, result: 'SUCCESS', correlationId,
      }, trx);
    });

    return { dataset_type_id: datasetTypeId, correlation_id: correlationId };
  }

  /**
   * Scan & register everything: register every folder in the (already background-
   * maintained) directory index that isn't a source dataset yet, and rescan every
   * already-registered one that isn't currently SCANNING. Each folder is an
   * independent worker job — reads the index table rather than walking disk, so this
   * is just a burst of per-folder register/rescan calls, not itself a background job.
   */
  async registerAllType(datasetTypeId: string, actor: Actor) {
    const correlationId = randomUUID();
    await this.assertDatasetTypeUsable(this.db, datasetTypeId);

    const entries = await this.db.selectFrom('dataset_directory_index')
      .select('sub_path').where('dataset_type_id', '=', datasetTypeId).execute();
    if (entries.length === 0) {
      throw err(errorCode.SOURCE_DATASET_DATASET_TYPE_INVALID, 'no folders indexed yet for this dataset type — run a rescan first', 400);
    }

    const registered = new Map(
      (await this.db.selectFrom('source_datasets')
        .select(['id', 'sub_path', 'status', 'archived_at'])
        .where('dataset_type_id', '=', datasetTypeId)
        .where('archived_at', 'is', null)
        .execute()
      ).map((r) => [r.sub_path ?? '', r]),
    );

    const results: Array<{ sub_path: string; action: 'registered' | 'rescanned' | 'skipped'; source_dataset_id?: string; reason?: string }> = [];

    for (const { sub_path: name } of entries) {
      const reg = registered.get(name);
      if (!reg) {
        const row = await this.ensure({ dataset_type_id: datasetTypeId, sub_path: name }, actor);
        results.push({ sub_path: name, action: 'registered', source_dataset_id: row.id });
        continue;
      }
      if (reg.status === 'SCANNING') {
        results.push({ sub_path: name, action: 'skipped', source_dataset_id: reg.id, reason: 'already scanning' });
        continue;
      }
      try {
        await this.rescan(reg.id, actor);
        results.push({ sub_path: name, action: 'rescanned', source_dataset_id: reg.id });
      } catch (e) {
        results.push({ sub_path: name, action: 'skipped', source_dataset_id: reg.id, reason: e instanceof Error ? e.message : 'rescan failed' });
      }
    }

    await this.auditService.append({
      actorType: 'USER', actorUserId: actor.id, actionCode: 'DATASET_TYPE_REGISTER_ALL_REQUESTED',
      resourceTypeCode: 'DATASET_TYPE', resourceId: datasetTypeId, result: 'SUCCESS', correlationId,
      metadata: { folders: results.length, results },
    });

    return { dataset_type_id: datasetTypeId, dispatched: results.filter((r) => r.action !== 'skipped').length, results };
  }

  async rescan(id: string, actor: Actor) {
    const correlationId = randomUUID();
    try {
      return await this.db.transaction().execute(async (trx) => {
        const sd = await trx.selectFrom('source_datasets').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!sd) throw err(errorCode.SOURCE_DATASET_NOT_FOUND, 'source dataset not found', 404);
        if (sd.archived_at) throw err(errorCode.SOURCE_DATASET_ALREADY_ARCHIVED, 'source dataset is archived', 409);
        const prev = await trx.selectFrom('source_dataset_scans').select(sql<number>`coalesce(max(scan_version),0)`.as('v'))
          .where('source_dataset_id', '=', id).executeTakeFirstOrThrow();
        const { scanId } = await this.dispatchScan(trx, id, Number(prev.v) + 1, actor, correlationId);
        await this.auditService.append({
          actorType: 'USER', actorUserId: actor.id, actionCode: 'SOURCE_DATASET_RESCAN_REQUESTED',
          resourceTypeCode: 'SOURCE_DATASET', resourceId: id, result: 'SUCCESS', correlationId,
          metadata: { scan_id: scanId },
        }, trx);
        return { scan_id: scanId };
      });
    } catch (e) {
      if (e instanceof Error && /uq_active_scan_per_source|duplicate key/.test(e.message)) {
        throw err(errorCode.DATASET_SCAN_ALREADY_RUNNING, 'a scan is already running for this source dataset', 409);
      }
      throw e;
    }
  }

  /**
   * Every YOLO label's first field is a class index that must fall inside the class
   * list (0 .. count-1). A list that is shorter than what the labels reference would
   * make the next training build fail, so the save is rejected up front rather than
   * silently corrupting a build. Reads only — the source folder stays untouched.
   */
  private async findOutOfRangeLabelIndices(
    sd: { relative_path: string; labels_relative_path: string; allow_subdirectories: boolean },
    classCount: number,
  ) {
    const labelsDir = normalizeRoot(path.join(normalizeRoot(sd.relative_path), sd.labels_relative_path));
    const files = (await this.walkFiles(labelsDir, sd.allow_subdirectories)).filter((f) => f.endsWith('.txt'));
    const offenders: Array<{ class_index: number; label_file: string }> = [];
    for (const f of files) {
      let text: string;
      try { text = await fs.promises.readFile(path.join(labelsDir, f), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        const first = line.trim().split(/\s+/)[0];
        if (first === '' || !/^\d+$/.test(first)) continue;
        const idx = Number(first);
        if (idx >= classCount) offenders.push({ class_index: idx, label_file: f });
      }
    }
    return offenders;
  }

  /**
   * Admin-supplied class list for a source dataset. Overrides any classes.txt on disk —
   * the scanner treats it as the highest-priority classes source (see worker.py), since
   * the read-only source folder can't be written to. Stored on the row only; setting or
   * clearing it dispatches a rescan so the effect is visible immediately.
   */
  async setClassesOverride(id: string, names: string[] | null, actor: Actor) {
    const correlationId = randomUUID();
    if (names !== null) {
      if (names.length === 0) throw err(errorCode.DATASET_CLASS_OVERRIDE_INVALID, 'names must be non-empty or null', 400);
      const trimmed = names.map((n) => n.trim());
      if (trimmed.some((n) => !n)) throw err(errorCode.DATASET_CLASS_OVERRIDE_INVALID, 'class names must be non-empty', 400);
      if (new Set(trimmed).size !== trimmed.length) throw err(errorCode.DATASET_CLASS_OVERRIDE_INVALID, 'class names must be unique', 400);
      names = trimmed;
    }
    return this.db.transaction().execute(async (trx) => {
      const sd = await trx.selectFrom('source_datasets').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!sd) throw err(errorCode.SOURCE_DATASET_NOT_FOUND, 'source dataset not found', 404);
      if (sd.archived_at) throw err(errorCode.SOURCE_DATASET_ALREADY_ARCHIVED, 'source dataset is archived', 409);
      if (names) {
        const offenders = await this.findOutOfRangeLabelIndices(sd, names.length);
        if (offenders.length > 0) {
          const shown = offenders.slice(0, 8).map((o) => `#${o.class_index} in ${o.label_file}`).join(', ');
          const message = `class list has ${names.length} name(s) but labels reference out-of-range indices (valid range 0–${names.length - 1}): ${shown}${offenders.length > 8 ? `, and ${offenders.length - 8} more` : ''}`;
          throw err(errorCode.DATASET_CLASS_OVERRIDE_INVALID, message, 400, {
            valid_range: [0, names.length - 1],
            offending: offenders.slice(0, 20),
          });
        }
      }
      await trx.updateTable('source_datasets')
        .set({ manual_classes_override: names ? JSON.stringify(names) as unknown as never : null, updated_at: sql`now()`, updated_by_user_id: actor.id })
        .where('id', '=', id).execute();
      const prev = await trx.selectFrom('source_dataset_scans').select(sql<number>`coalesce(max(scan_version),0)`.as('v'))
        .where('source_dataset_id', '=', id).executeTakeFirstOrThrow();
      const { scanId } = await this.dispatchScan(trx, id, Number(prev.v) + 1, actor, correlationId);
      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id, actionCode: 'SOURCE_DATASET_CLASSES_OVERRIDE_SET',
        resourceTypeCode: 'SOURCE_DATASET', resourceId: id, result: 'SUCCESS', correlationId,
        metadata: { class_count: names?.length ?? 0, scan_id: scanId },
      }, trx);
      return { id, scan_id: scanId };
    });
  }

  async listScans(id: string) {
    await this.findById(id);
    return this.db.selectFrom('source_dataset_scans').selectAll()
      .where('source_dataset_id', '=', id).orderBy('scan_version', 'desc').execute();
  }

  async getScan(id: string, scanId: string) {
    const row = await this.db.selectFrom('source_dataset_scans').selectAll()
      .where('id', '=', scanId).where('source_dataset_id', '=', id).executeTakeFirst();
    if (!row) throw err(errorCode.RESOURCE_NOT_FOUND, 'scan not found', 404);
    return row;
  }

  async getScanClasses(id: string, scanId: string, page: number, size: number) {
    await this.getScan(id, scanId);
    const s = Math.min(Math.max(size, 1), 200);
    const items = await this.db.selectFrom('source_dataset_classes').selectAll()
      .where('scan_id', '=', scanId).orderBy('class_index').limit(s).offset((page - 1) * s).execute();
    return items;
  }

  async getScanIssues(id: string, scanId: string, page: number, size: number, severity?: string) {
    await this.getScan(id, scanId);
    const s = Math.min(Math.max(size, 1), 200);
    let q = this.db.selectFrom('source_dataset_scan_issues').selectAll().where('scan_id', '=', scanId);
    if (severity) q = q.where('severity', '=', severity);
    return q.orderBy('created_at').limit(s).offset((page - 1) * s).execute();
  }

  private readonly SAFE_REL_FILENAME = /^[a-zA-Z0-9._/-]+$/;
  private readonly IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.tif', '.tiff']);

  /**
   * Source datasets have no train/val/test split — just one images/ and labels/ dir,
   * optionally with subdirectories (`allow_subdirectories`). Resolves and validates the
   * dataset's on-disk root the same way registration/scan does.
   */
  private async resolveSourceDir(id: string) {
    const sd = await this.db.selectFrom('source_datasets')
      .select(['id', 'status', 'relative_path', 'images_relative_path', 'labels_relative_path', 'task_type', 'allow_subdirectories', 'archived_at'])
      .where('id', '=', id).executeTakeFirst();
    if (!sd) throw err(errorCode.SOURCE_DATASET_NOT_FOUND, 'source dataset not found', 404);
    if (sd.archived_at || sd.status !== 'READY') {
      throw err(errorCode.SOURCE_DATASET_NOT_READY, 'source dataset is not ready for preview', 409);
    }
    const dir = normalizeRoot(sd.relative_path);
    return {
      imagesDir: normalizeRoot(path.join(dir, sd.images_relative_path)),
      labelsDir: normalizeRoot(path.join(dir, sd.labels_relative_path)),
      dir, taskType: sd.task_type, allowSubdirs: sd.allow_subdirectories,
    };
  }

  private async walkFiles(root: string, allowSubdirs: boolean): Promise<string[]> {
    const out: string[] = [];
    async function walk(dir: string, rel: string): Promise<void> {
      let entries: import('fs').Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (allowSubdirs) await walk(`${dir}/${e.name}`, childRel);
        } else if (e.isFile()) {
          out.push(childRel);
        }
      }
    }
    await walk(root, '');
    return out;
  }

  async listSamples(id: string, limit: number, offset: number) {
    const { imagesDir, allowSubdirs } = await this.resolveSourceDir(id);
    const files = (await this.walkFiles(imagesDir, allowSubdirs))
      .filter((f) => this.IMAGE_EXTS.has(path.extname(f).toLowerCase()))
      .sort();
    return { files: files.slice(offset, offset + limit), total: files.length };
  }

  private resolveSampleFile(dir: string, filename: string): string {
    if (!this.SAFE_REL_FILENAME.test(filename)) throw err(errorCode.VALIDATION_FAILED, 'invalid filename', 400);
    const full = normalizeRoot(path.join(dir, filename));
    if (!isWithinRoot(full, dir)) throw err(errorCode.VALIDATION_FAILED, 'invalid filename', 400);
    return full;
  }

  async getSampleImagePath(id: string, filename: string): Promise<string> {
    const { imagesDir } = await this.resolveSourceDir(id);
    const full = this.resolveSampleFile(imagesDir, filename);
    try {
      await fs.promises.access(full, fs.constants.R_OK);
    } catch {
      throw err(errorCode.RESOURCE_NOT_FOUND, 'sample image not found', 404);
    }
    return full;
  }

  async getSampleLabels(id: string, filename: string) {
    const { labelsDir, taskType } = await this.resolveSourceDir(id);
    const stem = filename.replace(/\.[^./]+$/, '');
    const full = this.resolveSampleFile(labelsDir, `${stem}.txt`);

    let text: string;
    try {
      text = await fs.promises.readFile(full, 'utf8');
    } catch {
      return { task_type: taskType, boxes: [] };
    }

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
