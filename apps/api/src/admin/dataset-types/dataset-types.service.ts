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

  async delete(id: string, actor: Actor) {
    const correlationId = crypto.randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const row = await this.findExists(trx, id);
      if (row.is_system) throw err(errorCode.DATASET_TYPE_SYSTEM_PROTECTED, 'system type cannot be deleted', 409);
      const children = await trx.selectFrom('dataset_types').select('id').where('parent_id', '=', id).execute();
      if (children.length > 0) throw err(errorCode.DATASET_TYPE_HAS_CHILDREN, 'cannot delete type with children', 400, { childCount: children.length });
      const dsCount = await trx.selectFrom('training_datasets').select(sql<number>`count(*)`.as('count')).where('dataset_type_id', '=', id).executeTakeFirstOrThrow();
      if (dsCount.count > 0) throw err(errorCode.DATASET_TYPE_IN_USE, 'cannot delete type with associated datasets', 400, { datasetCount: dsCount.count });
      await this.auditService.append({
        actorType: 'USER', actorUserId: actor.id, actionCode: 'DATASET_TYPE_DELETED',
        resourceTypeCode: 'DATASET_TYPE', resourceId: id, result: 'SUCCESS', correlationId,
        beforeSnapshot: row as unknown as Record<string, unknown>,
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
