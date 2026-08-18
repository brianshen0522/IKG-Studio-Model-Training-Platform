import { Inject, Injectable, HttpException } from '@nestjs/common';
import { DB_PROVIDER } from '../../database/database.module';
import { type Kysely, sql } from 'kysely';
import type { Database } from '@model-trainer/db';
import { errorCode } from '@model-trainer/shared-types';
import { AuditService } from '../../audit/audit.service';
import { OutboxService } from '../../outbox/outbox.service';
import { DatasetTypesTreeService } from './dataset-types-tree.service';
import { DatasetTypesValidatorService } from './dataset-types-validator.service';
import { rootRelation } from '../../common/roots';
import { dispatchDirectoryReindex } from '../../source-datasets/reindex';

const COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;
const ICON_WHITELIST = new Set([
  'folder', 'database', 'scan', 'box', 'crosshair', 'image', 'car', 'plane', 'ship', 'layers', 'tag',
]);

const FIELDS = [
  'id', 'name', 'parent_id', 'description', 'icon', 'color',
  'dataset_path', 'model_path', 'training_dataset_path', 'sort_order', 'enabled', 'is_system', 'row_version',
  'created_at', 'created_by_user_id', 'updated_at', 'updated_by_user_id',
] as const;

type Exec = Kysely<Database>;
type Actor = { id: string; role: string };
const err = (code: string, message: string, status: number, details?: Record<string, unknown>) =>
  new HttpException({ error: { code, message, details, requestId: '' } }, status);

@Injectable()
export class DatasetTypesService {
  constructor(
    @Inject(DB_PROVIDER) private readonly db: Kysely<Database>,
    private readonly auditService: AuditService,
    private readonly outboxService: OutboxService,
    private readonly tree: DatasetTypesTreeService,
    private readonly validator: DatasetTypesValidatorService,
  ) {}

  private async maxDepth(exec: Exec): Promise<number> {
    const r = await exec.selectFrom('system_settings').select('value')
      .where('setting_key', '=', 'dataset_type_max_depth').executeTakeFirst();
    return Number((r?.value as unknown) ?? 8) || 8;
  }

  private validateStatic(input: { color?: string | null; icon?: string | null; dataset_path?: string | null; model_path?: string | null; training_dataset_path?: string | null }) {
    if (input.color != null && !COLOR_REGEX.test(input.color)) {
      throw err(errorCode.DATASET_TYPE_INVALID_COLOR, 'color must be a #RRGGBB hex value', 400);
    }
    if (input.icon != null && !ICON_WHITELIST.has(input.icon)) {
      throw err(errorCode.DATASET_TYPE_INVALID_ICON, 'icon is not in the allowed set', 400);
    }
    if (input.dataset_path !== undefined && input.dataset_path !== null && input.dataset_path !== '') {
      if (!input.dataset_path.startsWith('/')) {
        throw err(errorCode.DATASET_PATH_INVALID, 'dataset_path must be an absolute path', 400);
      }
      if (input.dataset_path.includes('\0') || input.dataset_path.includes('..')) {
        throw err(errorCode.DATASET_PATH_INVALID, 'dataset_path must not contain null bytes or ..', 400);
      }
    }
    if (input.model_path !== undefined && input.model_path !== null && input.model_path !== '') {
      if (!input.model_path.startsWith('/')) {
        throw err(errorCode.DATASET_PATH_INVALID, 'model_path must be an absolute path', 400);
      }
      if (input.model_path.includes('\0') || input.model_path.includes('..')) {
        throw err(errorCode.DATASET_PATH_INVALID, 'model_path must not contain null bytes or ..', 400);
      }
    }
    if (input.training_dataset_path !== undefined && input.training_dataset_path !== null && input.training_dataset_path !== '') {
      if (!input.training_dataset_path.startsWith('/')) {
        throw err(errorCode.DATASET_PATH_INVALID, 'training_dataset_path must be an absolute path', 400);
      }
      if (input.training_dataset_path.includes('\0') || input.training_dataset_path.includes('..')) {
        throw err(errorCode.DATASET_PATH_INVALID, 'training_dataset_path must not contain null bytes or ..', 400);
      }
    }
  }

  /**
   * Model Roots are walked recursively to discover checkpoints, so a root that contains
   * (or equals) another type's root makes the same file discoverable from two types and
   * registers it twice. The scanner now delegates nested subtrees to the deeper type,
   * but a nested root is still a configuration mistake — the enclosing type silently
   * loses everything under it — so refuse it at the source.
   *
   * Only model_path is checked: dataset_path is browsed, never auto-registered, and
   * training datasets are addressed by an explicit relative_path rather than discovered.
   */
  private async assertModelRootNotNested(
    exec: Exec, modelPath: string | null | undefined, excludeId?: string,
  ) {
    if (!modelPath || !modelPath.trim()) return;
    let q = exec.selectFrom('dataset_types').select(['id', 'name', 'model_path'])
      .where('model_path', 'is not', null);
    if (excludeId) q = q.where('id', '!=', excludeId);

    const PHRASE: Record<string, string> = {
      same: 'is already used by',
      inside: 'is inside the Model Root of',
      contains: 'contains the Model Root of',
    };
    for (const other of await q.execute()) {
      const relation = rootRelation(modelPath, other.model_path as string);
      if (relation) {
        throw err(
          errorCode.DATASET_PATH_INVALID,
          `model_path ${PHRASE[relation]} dataset type "${other.name}" (${other.model_path}). ` +
          'Model Roots are scanned recursively, so they must not overlap.',
          400,
          { conflicting_dataset_type_id: other.id, conflicting_model_path: other.model_path },
        );
      }
    }
  }

  /**
   * source_datasets.relative_path is an absolute snapshot taken at registration
   * (`<effective dataset_path>/<sub_path>`) and is never rewritten, so moving the root
   * out from under it leaves every registered row pointing at the old location — the
   * worker then scans stale data or fails with DATASET_PATH_NOT_FOUND. Freeze the root
   * once anything is registered; archiving is the escape hatch.
   *
   * Covers the inheritance chain: a descendant with no dataset_path of its own resolves
   * to this one, so it is affected too. Descent stops at any descendant that defines its
   * own root (it and its subtree inherit from there instead).
   *
   * dataset_directory_index is deliberately NOT considered — it is a pure cache with no
   * absolute paths and no referents, and the reindex dispatched by the path change
   * rebuilds it wholesale.
   */
  private async assertNoRegisteredSources(exec: Exec, id: string) {
    const affected = await sql<{ id: string }>`
      WITH RECURSIVE inheriting AS (
        SELECT id FROM app.dataset_types WHERE id = ${id}
        UNION ALL
        SELECT c.id FROM app.dataset_types c JOIN inheriting i ON c.parent_id = i.id
        WHERE c.dataset_path IS NULL
      )
      SELECT id FROM inheriting
    `.execute(exec);
    const ids = affected.rows.map((r) => r.id);

    const rows = await exec.selectFrom('source_datasets')
      .select(['id', 'name', 'dataset_type_id'])
      .where('dataset_type_id', 'in', ids)
      .where('archived_at', 'is', null)
      .limit(5).execute();
    if (rows.length === 0) return;

    const { count } = await exec.selectFrom('source_datasets')
      .select(sql<number>`count(*)`.as('count'))
      .where('dataset_type_id', 'in', ids)
      .where('archived_at', 'is', null)
      .executeTakeFirstOrThrow();
    throw err(
      errorCode.DATASET_TYPE_IN_USE,
      `dataset_path cannot be changed while ${count} source dataset(s) are registered under it. ` +
      'Archive them first, then change the path and register again from the new root.',
      409,
      { source_dataset_count: Number(count), sample_source_datasets: rows },
    );
  }

  private async assertSiblingNameFree(exec: Exec, parentId: string | null, name: string, excludeId?: string) {
    let q = exec.selectFrom('dataset_types').select('id').where(sql`lower(name)`, '=', name.toLowerCase());
    q = parentId === null ? q.where('parent_id', 'is', null) : q.where('parent_id', '=', parentId);
    if (excludeId) q = q.where('id', '!=', excludeId);
    if (await q.executeTakeFirst()) {
      throw err(errorCode.DATASET_TYPE_NAME_ALREADY_EXISTS, 'a sibling with this name already exists', 409);
    }
  }

  async list() {
    const items = await this.db.selectFrom('dataset_types').select(FIELDS)
      .orderBy('parent_id').orderBy('sort_order').orderBy('name').execute();
    return items;
  }

  async getTree() {
    return this.tree.buildTree(this.db);
  }

  async findById(id: string) {
    const row = await this.db.selectFrom('dataset_types').select(FIELDS).where('id', '=', id).executeTakeFirst();
    if (!row) throw err(errorCode.DATASET_TYPE_NOT_FOUND, 'dataset type not found', 404);
    const [effPath, effEnabled, usage, breadcrumb] = await Promise.all([
      this.tree.effectiveBasePath(this.db, id),
      this.tree.effectiveEnabled(this.db, id),
      this.tree.usage(this.db, id),
      this.tree.breadcrumb(this.db, id),
    ]);
    return { ...row, effective_dataset_path: effPath, ...effEnabled, usage, breadcrumb };
  }

  async usage(id: string) {
    await this.findExists(this.db, id);
    return this.tree.usage(this.db, id);
  }

  private async findExists(exec: Exec, id: string) {
    const row = await exec.selectFrom('dataset_types').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!row) throw err(errorCode.DATASET_TYPE_NOT_FOUND, 'dataset type not found', 404);
    return row;
  }

  async create(
    input: {
      name: string; parent_id?: string | null; description?: string | null;
      icon?: string | null; color?: string | null;
      dataset_path?: string | null; model_path?: string | null; training_dataset_path?: string | null;
      sort_order?: number; enabled?: boolean;
    },
    actor: Actor,
  ) {
    this.validateStatic({ color: input.color, icon: input.icon, dataset_path: input.dataset_path, model_path: input.model_path, training_dataset_path: input.training_dataset_path });
    if (!input.dataset_path || !input.dataset_path.trim()) {
      throw err(errorCode.VALIDATION_FAILED, 'dataset_path is required', 400);
    }
    if (!input.model_path || !input.model_path.trim()) {
      throw err(errorCode.VALIDATION_FAILED, 'model_path is required', 400);
    }
    if (!input.training_dataset_path || !input.training_dataset_path.trim()) {
      throw err(errorCode.VALIDATION_FAILED, 'training_dataset_path is required', 400);
    }
    this.validator.validateDatasetPath(input.dataset_path);
    this.validator.validateModelPath(input.model_path);
    const correlationId = crypto.randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const parentId = input.parent_id ?? null;
      if (parentId !== null) {
        const parent = await trx.selectFrom('dataset_types').select('id').where('id', '=', parentId).executeTakeFirst();
        if (!parent) throw err(errorCode.DATASET_TYPE_PARENT_NOT_FOUND, 'parent not found', 400);
        const eff = await this.tree.effectiveEnabled(trx, parentId);
        if (!eff.effective_enabled) throw err(errorCode.DATASET_TYPE_PARENT_DISABLED, 'parent is disabled', 400);
        const newDepth0 = (await this.tree.depthOf(trx, parentId)) + 1;
        if (newDepth0 + 1 > (await this.maxDepth(trx))) {
          throw err(errorCode.DATASET_TYPE_MAX_DEPTH_EXCEEDED, 'maximum tree depth exceeded', 400);
        }
      }
      await this.assertSiblingNameFree(trx, parentId, input.name);
      await this.assertModelRootNotNested(trx, input.model_path);

      const { id } = await trx.insertInto('dataset_types').values({
        name: input.name,
        parent_id: parentId,
        description: input.description ?? null,
        icon: input.icon ?? null,
        color: input.color ?? null,
        dataset_path: input.dataset_path!,
        model_path: input.model_path!,
        training_dataset_path: input.training_dataset_path ?? null,
        sort_order: input.sort_order ?? 0,
        enabled: input.enabled ?? true,
        is_system: false,
        created_by_user_id: actor.id,
        updated_by_user_id: actor.id,
      }).returning('id').executeTakeFirstOrThrow();

      const row = await trx.selectFrom('dataset_types').select(FIELDS).where('id', '=', id).executeTakeFirstOrThrow();
      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id, actionCode: 'DATASET_TYPE_CREATED',
        resourceTypeCode: 'DATASET_TYPE', resourceId: id, result: 'SUCCESS', correlationId,
        afterSnapshot: row as unknown as Record<string, unknown>,
      }, trx);
      await this.outboxService.enqueue({
        eventType: 'dataset-type.changed', aggregateTypeCode: 'DATASET_TYPE', aggregateId: id,
        payload: { id, action: 'created' } as Record<string, unknown>, correlationId,
      }, trx);
      await dispatchDirectoryReindex(this.outboxService, trx, id, correlationId);
      return row;
    });
  }

  async update(
    id: string,
    input: {
      name?: string; description?: string | null; icon?: string | null; color?: string | null;
      dataset_path?: string | null; model_path?: string | null; training_dataset_path?: string | null;
      sort_order?: number; enabled?: boolean; row_version: number;
    },
    actor: Actor,
  ) {
    this.validateStatic({ color: input.color, icon: input.icon, dataset_path: input.dataset_path, model_path: input.model_path, training_dataset_path: input.training_dataset_path });
    const correlationId = crypto.randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const row = await this.findExists(trx, id);
      if (row.row_version !== input.row_version) {
        throw err(errorCode.DATASET_TYPE_CONCURRENT_UPDATE, 'dataset type was modified by another request', 409, { current_row_version: row.row_version });
      }
      if (row.is_system) {
        if (input.name !== undefined && input.name !== row.name) throw err(errorCode.DATASET_TYPE_SYSTEM_PROTECTED, 'system type name cannot be changed', 409);
        if (input.enabled !== undefined && input.enabled !== row.enabled) throw err(errorCode.DATASET_TYPE_SYSTEM_PROTECTED, 'system type enabled cannot be changed here', 409);
      }
      if (input.name !== undefined && input.name.toLowerCase() !== row.name.toLowerCase()) {
        await this.assertSiblingNameFree(trx, row.parent_id, input.name, id);
      }
      // Only when the caller actually moves the root — an unrelated edit (rename, colour)
      // must not start failing because of an overlap that predates this rule.
      if (input.model_path !== undefined && input.model_path !== row.model_path) {
        await this.assertModelRootNotNested(trx, input.model_path, id);
      }
      if (input.dataset_path !== undefined && input.dataset_path !== row.dataset_path) {
        await this.assertNoRegisteredSources(trx, id);
      }

      const before: Record<string, unknown> = {
        name: row.name, description: row.description, icon: row.icon, color: row.color,
        dataset_path: row.dataset_path, model_path: row.model_path, training_dataset_path: row.training_dataset_path, sort_order: row.sort_order, enabled: row.enabled,
      };
      const set: Record<string, unknown> = { row_version: sql`row_version + 1`, updated_at: sql`now()`, updated_by_user_id: actor.id };
      for (const k of ['name', 'description', 'icon', 'color', 'dataset_path', 'model_path', 'training_dataset_path', 'sort_order', 'enabled'] as const) {
        if (input[k] !== undefined) set[k] = input[k];
      }
      await trx.updateTable('dataset_types').set(set).where('id', '=', id).execute();
      const updated = await trx.selectFrom('dataset_types').select(FIELDS).where('id', '=', id).executeTakeFirstOrThrow();

      const after: Record<string, unknown> = {
        name: updated.name, description: updated.description, icon: updated.icon, color: updated.color,
        dataset_path: updated.dataset_path, model_path: updated.model_path, training_dataset_path: updated.training_dataset_path, sort_order: updated.sort_order, enabled: updated.enabled,
      };
      const diff: Record<string, unknown> = {};
      for (const k of Object.keys(before)) {
        if (String(before[k]) !== String(after[k])) diff[k] = { before: before[k], after: after[k] };
      }
      const pathChanged = 'dataset_path' in diff || 'model_path' in diff;
      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id,
        actionCode: pathChanged ? 'DATASET_TYPE_PATH_CHANGED' : 'DATASET_TYPE_UPDATED',
        resourceTypeCode: 'DATASET_TYPE', resourceId: id, result: 'SUCCESS', correlationId,
        beforeSnapshot: before, afterSnapshot: after, diff,
      }, trx);
      await this.outboxService.enqueue({
        eventType: 'dataset-type.changed', aggregateTypeCode: 'DATASET_TYPE', aggregateId: id,
        payload: { id, changes: Object.keys(diff) } as Record<string, unknown>, correlationId,
      }, trx);
      if ('dataset_path' in diff) await dispatchDirectoryReindex(this.outboxService, trx, id, correlationId);
      return updated;
    });
  }

  private async setEnabled(id: string, enabled: boolean, actor: Actor) {
    const correlationId = crypto.randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const row = await this.findExists(trx, id);
      if (row.is_system) throw err(errorCode.DATASET_TYPE_SYSTEM_PROTECTED, 'system type enabled cannot be changed here', 409);
      await trx.updateTable('dataset_types').set({
        enabled,
        row_version: sql`row_version + 1`,
        updated_at: sql`now()`,
        updated_by_user_id: actor.id,
      }).where('id', '=', id).execute();
      const updated = await trx.selectFrom('dataset_types').select(FIELDS).where('id', '=', id).executeTakeFirstOrThrow();
      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id,
        actionCode: enabled ? 'DATASET_TYPE_ENABLED' : 'DATASET_TYPE_DISABLED',
        resourceTypeCode: 'DATASET_TYPE', resourceId: id, result: 'SUCCESS', correlationId,
        beforeSnapshot: { enabled: row.enabled }, afterSnapshot: { enabled },
      }, trx);
      await this.outboxService.enqueue({
        eventType: 'dataset-type.changed', aggregateTypeCode: 'DATASET_TYPE', aggregateId: id,
        payload: { id, changes: ['enabled'] } as Record<string, unknown>, correlationId,
      }, trx);
      return updated;
    });
  }

  async enable(id: string, actor: Actor) { return this.setEnabled(id, true, actor); }
  async disable(id: string, actor: Actor) { return this.setEnabled(id, false, actor); }

  private async countReferencing(exec: Exec, table: string, id: string, liveOnly = false): Promise<number> {
    const filter = liveOnly ? ' AND archived_at IS NULL' : '';
    const r = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM app.${sql.raw(table)}
      WHERE dataset_type_id = ${id}${sql.raw(filter)}
    `.execute(exec);
    return Number(r.rows[0].count);
  }

  /**
   * Archived source/training datasets are tombstones, but their FKs to dataset_types are
   * ON DELETE RESTRICT all the same — so without this the documented "archive it, then
   * delete the type" path is a dead end: archiving never lowers the count that blocks the
   * delete. Tombstones are therefore purged along with the type that owned them.
   *
   * Their own dependents (scans, jobs, benchmark rows) are RESTRICT too, so anything still
   * pointing at a tombstone is reported as a blocker rather than cascaded into — those are
   * real history, not tombstones, and must not disappear because a type was tidied up.
   */
  private async purgeArchivedDatasets(trx: Exec, id: string): Promise<Record<string, number>> {
    const held: Record<string, number> = {};
    const countDependents = async (table: string, column: string, parentTable: string) => {
      const r = await sql<{ count: string }>`
        SELECT count(*)::text AS count FROM app.${sql.raw(table)} d
        JOIN app.${sql.raw(parentTable)} p ON p.id = d.${sql.raw(column)}
        WHERE p.dataset_type_id = ${id} AND p.archived_at IS NOT NULL
      `.execute(trx);
      return Number(r.rows[0].count);
    };

    const jobs = await countDependents('training_jobs', 'training_dataset_id', 'training_datasets');
    const evals = await countDependents('benchmark_evaluations', 'training_dataset_id', 'training_datasets');
    const runDatasets = await countDependents('benchmark_run_datasets', 'training_dataset_id', 'training_datasets');
    if (jobs > 0) held.training_jobs = jobs;
    if (evals > 0) held.benchmark_evaluations = evals;
    if (runDatasets > 0) held.benchmark_run_datasets = runDatasets;
    if (Object.keys(held).length > 0) return held;

    // Scans are pure scan history for a dataset that is already a tombstone, so they go
    // with it; nothing else references them. source_datasets and source_dataset_scans
    // reference each other, and both directions are RESTRICT, so the latest_scan_id back
    // pointer has to be dropped before the scans it points at can go.
    await sql`
      UPDATE app.source_datasets SET latest_scan_id = NULL
      WHERE dataset_type_id = ${id} AND archived_at IS NOT NULL
    `.execute(trx);
    await sql`
      DELETE FROM app.source_dataset_scans s
      USING app.source_datasets sd
      WHERE s.source_dataset_id = sd.id
        AND sd.dataset_type_id = ${id} AND sd.archived_at IS NOT NULL
    `.execute(trx);
    await sql`
      DELETE FROM app.source_datasets
      WHERE dataset_type_id = ${id} AND archived_at IS NOT NULL
    `.execute(trx);
    await sql`
      DELETE FROM app.training_datasets
      WHERE dataset_type_id = ${id} AND archived_at IS NOT NULL
    `.execute(trx);
    return held;
  }

  async delete(id: string, actor: Actor) {
    const correlationId = crypto.randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const row = await this.findExists(trx, id);
      if (row.is_system) throw err(errorCode.DATASET_TYPE_SYSTEM_PROTECTED, 'system type cannot be deleted', 409);
      const children = await trx.selectFrom('dataset_types').select('id').where('parent_id', '=', id).execute();
      if (children.length > 0) throw err(errorCode.DATASET_TYPE_HAS_CHILDREN, 'cannot delete type with children', 400, { childCount: children.length });

      // Every one of these FKs is ON DELETE RESTRICT, so anything left unchecked
      // surfaces as a raw Postgres error instead of a usable message. Only live rows
      // block: archived ones are tombstones and get purged below, which is what makes
      // "archive the datasets, then delete the type" actually terminate.
      const counts = {
        training_datasets: await this.countReferencing(trx, 'training_datasets', id, true),
        source_datasets: await this.countReferencing(trx, 'source_datasets', id, true),
        // Not live-only: models are immutable artifacts and are never purged here, so
        // an archived one still blocks — otherwise it would slip past into a raw FK error.
        models: await this.countReferencing(trx, 'models', id),
        model_ingest_tasks: await this.countReferencing(trx, 'model_ingest_tasks', id),
      };
      const blocking = Object.entries(counts).filter(([, n]) => n > 0);
      if (blocking.length > 0) {
        const parts = blocking.map(([t, n]) => `${n} ${t.replace(/_/g, ' ')}`).join(', ');
        throw err(
          errorCode.DATASET_TYPE_IN_USE,
          `cannot delete a dataset type still referenced by ${parts}. ` +
          'Archive or remove them first, or disable the type instead.',
          400,
          counts,
        );
      }

      const purged = {
        training_datasets: await this.countReferencing(trx, 'training_datasets', id),
        source_datasets: await this.countReferencing(trx, 'source_datasets', id),
      };
      const heldByHistory = await this.purgeArchivedDatasets(trx, id);
      if (Object.keys(heldByHistory).length > 0) {
        const parts = Object.entries(heldByHistory)
          .map(([t, n]) => `${n} ${t.replace(/_/g, ' ')}`).join(', ');
        throw err(
          errorCode.DATASET_TYPE_IN_USE,
          `archived datasets under this type are still referenced by ${parts}, ` +
          'which would be lost. Delete those first, or disable the type instead.',
          400,
          heldByHistory,
        );
      }
      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id, actionCode: 'DATASET_TYPE_DELETED',
        resourceTypeCode: 'DATASET_TYPE', resourceId: id, result: 'SUCCESS', correlationId,
        beforeSnapshot: row as unknown as Record<string, unknown>,
        metadata: { purged_archived: purged },
      }, trx);
      await trx.deleteFrom('dataset_types').where('id', '=', id).execute();
      await this.outboxService.enqueue({
        eventType: 'dataset-type.changed', aggregateTypeCode: 'DATASET_TYPE', aggregateId: id,
        payload: { id, action: 'deleted' } as Record<string, unknown>, correlationId,
      }, trx);
      return { id };
    });
  }

  /**
   * Every dataset type is selectable. There used to be a seeded `Unclassified` row that
   * callers opted into; it was removed in migration 003, so there is nothing to filter.
   */
  async options() {
    return this.db.selectFrom('dataset_types')
      .select(['id', 'name', 'parent_id', 'enabled', 'icon', 'color'])
      .orderBy('parent_id').orderBy('sort_order').orderBy('name').execute();
  }

  async reorder(input: { parent_id: string | null; items: { dataset_type_id: string; sort_order: number; row_version: number }[] }, actor: Actor) {
    const correlationId = crypto.randomUUID();
    return this.db.transaction().execute(async (trx) => {
      for (const item of input.items) {
        await trx.updateTable('dataset_types').set({
          sort_order: item.sort_order,
          parent_id: input.parent_id,
          row_version: sql`row_version + 1`,
          updated_at: sql`now()`,
          updated_by_user_id: actor.id,
        }).where('id', '=', item.dataset_type_id).execute();
      }
      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id, actionCode: 'DATASET_TYPE_REORDERED',
        resourceTypeCode: 'DATASET_TYPE', resourceId: input.parent_id ?? '__root__', result: 'SUCCESS', correlationId,
        metadata: { items: input.items },
      }, trx);
      return this.getTree();
    });
  }

  async move(id: string, input: { new_parent_id: string | null; new_sort_order?: number; row_version: number }, actor: Actor) {
    const correlationId = crypto.randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const row = await this.findExists(trx, id);
      if (row.row_version !== input.row_version) {
        throw err(errorCode.DATASET_TYPE_CONCURRENT_UPDATE, 'dataset type was modified by another request', 409, { current_row_version: row.row_version });
      }
      if (input.new_parent_id !== null) {
        const parent = await trx.selectFrom('dataset_types').select('id').where('id', '=', input.new_parent_id).executeTakeFirst();
        if (!parent) throw err(errorCode.DATASET_TYPE_PARENT_NOT_FOUND, 'parent not found', 400);
        const eff = await this.tree.effectiveEnabled(trx, input.new_parent_id);
        if (!eff.effective_enabled) throw err(errorCode.DATASET_TYPE_PARENT_DISABLED, 'parent is disabled', 400);
        const newDepth0 = (await this.tree.depthOf(trx, input.new_parent_id)) + 1;
        if (newDepth0 + 1 > (await this.maxDepth(trx))) {
          throw err(errorCode.DATASET_TYPE_MAX_DEPTH_EXCEEDED, 'maximum tree depth exceeded', 400);
        }
      }
      const set: Record<string, unknown> = {
        parent_id: input.new_parent_id,
        row_version: sql`row_version + 1`,
        updated_at: sql`now()`,
        updated_by_user_id: actor.id,
      };
      if (input.new_sort_order !== undefined) set.sort_order = input.new_sort_order;
      await trx.updateTable('dataset_types').set(set).where('id', '=', id).execute();
      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id, actionCode: 'DATASET_TYPE_MOVED',
        resourceTypeCode: 'DATASET_TYPE', resourceId: id, result: 'SUCCESS', correlationId,
        beforeSnapshot: { parent_id: row.parent_id, sort_order: row.sort_order },
        afterSnapshot: { parent_id: input.new_parent_id, sort_order: input.new_sort_order },
      }, trx);
      return this.getTree();
    });
  }

  async history(id: string, cursor?: number, size?: number) {
    return this.db.selectFrom('audit_logs')
      .select(['id', 'action_code', 'actor_user_id', 'before_snapshot', 'after_snapshot', 'diff', 'occurred_at'])
      .where('resource_type_code', '=', 'DATASET_TYPE').where('resource_id', '=', id)
      .orderBy('occurred_at', 'desc')
      .limit(Math.min(size ?? 50, 200))
      .$if(cursor !== undefined, (q) => q.where('id', '<', cursor!))
      .execute();
  }
}
