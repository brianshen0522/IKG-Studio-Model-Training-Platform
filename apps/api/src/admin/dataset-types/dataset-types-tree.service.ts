import { Inject, Injectable } from '@nestjs/common';
import { DB_PROVIDER } from '../../database/database.module';
import { type Kysely, sql } from 'kysely';
import type { Database } from '@model-trainer/db';

type Exec = Kysely<Database>;

export interface UsageCounts {
  source_dataset_count: number;
  dataset_count: number;
  model_count: number;
  direct_child_count: number;
  descendant_count: number;
}

@Injectable()
export class DatasetTypesTreeService {
  constructor(@Inject(DB_PROVIDER) private readonly db: Kysely<Database>) {}

  async effectiveBasePath(exec: Exec, id: string): Promise<{ dataset_path: string; inherited: boolean; inherited_from_dataset_type_id: string } | null> {
    const res = await sql<{ dataset_path: string; anc_id: string; depth: number }>`
      WITH RECURSIVE anc AS (
        SELECT id, parent_id, dataset_path, 0 AS depth
        FROM app.dataset_types WHERE id = ${id}
        UNION ALL
        SELECT p.id, p.parent_id, p.dataset_path, a.depth + 1
        FROM app.dataset_types p JOIN anc a ON a.parent_id = p.id
      )
      SELECT dataset_path, id AS anc_id, depth
      FROM anc WHERE dataset_path IS NOT NULL
      ORDER BY depth ASC LIMIT 1
    `.execute(exec);
    const hit = res.rows[0];
    if (!hit) return null;
    return {
      dataset_path: hit.dataset_path,
      inherited: Number(hit.depth) > 0,
      inherited_from_dataset_type_id: hit.anc_id,
    };
  }

  async effectiveEnabled(
    exec: Exec,
    id: string,
  ): Promise<{ effective_enabled: boolean; disabled_by_ancestor_id: string | null }> {
    const res = await sql<{ id: string; enabled: boolean; depth: number }>`
      WITH RECURSIVE anc AS (
        SELECT id, parent_id, enabled, 0 AS depth
        FROM app.dataset_types WHERE id = ${id}
        UNION ALL
        SELECT p.id, p.parent_id, p.enabled, a.depth + 1
        FROM app.dataset_types p JOIN anc a ON a.parent_id = p.id
      )
      SELECT id, enabled, depth FROM anc WHERE enabled = false ORDER BY depth ASC
    `.execute(exec);
    if (res.rows.length === 0) return { effective_enabled: true, disabled_by_ancestor_id: null };
    const ancestorDisabled = res.rows.find((r) => Number(r.depth) > 0);
    return { effective_enabled: false, disabled_by_ancestor_id: ancestorDisabled ? ancestorDisabled.id : null };
  }

  async depthOf(exec: Exec, id: string): Promise<number> {
    const res = await sql<{ depth: number }>`
      WITH RECURSIVE anc AS (
        SELECT id, parent_id, 0 AS depth
        FROM app.dataset_types WHERE id = ${id}
        UNION ALL
        SELECT p.id, p.parent_id, a.depth + 1
        FROM app.dataset_types p JOIN anc a ON a.parent_id = p.id
      )
      SELECT max(depth) AS depth FROM anc
    `.execute(exec);
    return Number(res.rows[0]?.depth ?? 0);
  }

  async descendantIds(exec: Exec, id: string): Promise<string[]> {
    const res = await sql<{ id: string }>`
      WITH RECURSIVE des AS (
        SELECT id FROM app.dataset_types WHERE parent_id = ${id}
        UNION ALL
        SELECT c.id FROM app.dataset_types c JOIN des d ON c.parent_id = d.id
      )
      SELECT id FROM des
    `.execute(exec);
    return res.rows.map((r) => r.id);
  }

  async subtreeRelativeMaxDepth(exec: Exec, id: string): Promise<number> {
    const res = await sql<{ d: number }>`
      WITH RECURSIVE des AS (
        SELECT id, 0 AS d FROM app.dataset_types WHERE id = ${id}
        UNION ALL
        SELECT c.id, des.d + 1 FROM app.dataset_types c JOIN des ON c.parent_id = des.id
      )
      SELECT max(d) AS d FROM des
    `.execute(exec);
    return Number(res.rows[0]?.d ?? 0);
  }

  async breadcrumb(exec: Exec, id: string): Promise<string> {
    const res = await sql<{ name: string; depth: number }>`
      WITH RECURSIVE anc AS (
        SELECT id, parent_id, name, 0 AS depth
        FROM app.dataset_types WHERE id = ${id}
        UNION ALL
        SELECT p.id, p.parent_id, p.name, a.depth + 1
        FROM app.dataset_types p JOIN anc a ON a.parent_id = p.id
      )
      SELECT name, depth FROM anc ORDER BY depth DESC
    `.execute(exec);
    return res.rows.map((r) => r.name).join(' / ');
  }

  async usage(exec: Exec, id: string): Promise<UsageCounts> {
    const q = async (table: string, col: string, extra = '') => {
      const r = await sql<{ count: string }>`
        SELECT count(*)::text AS count FROM app.${sql.raw(table)} WHERE ${sql.raw(col)} = ${id} ${sql.raw(extra)}
      `.execute(exec);
      return Number(r.rows[0].count);
    };
    const source_dataset_count = await q('source_datasets', 'dataset_type_id');
    const dataset_count = await q('training_datasets', 'dataset_type_id', 'AND archived_at IS NULL');
    const model_count = await q('models', 'dataset_type_id');
    const direct_child_count = await q('dataset_types', 'parent_id');
    const descendant_count = (await this.descendantIds(exec, id)).length;
    return { source_dataset_count, dataset_count, model_count, direct_child_count, descendant_count };
  }

  async buildTree(exec: Exec): Promise<Record<string, unknown>[]> {
    const nodes = await exec
      .selectFrom('dataset_types')
      .select([
        'id', 'name', 'parent_id', 'description', 'icon', 'color',
        'dataset_path', 'model_path', 'training_dataset_path', 'sort_order', 'enabled', 'is_system', 'row_version',
      ])
      .execute();

    const usageMap = new Map<string, { s: number; d: number; m: number }>();
    for (const [table, key] of [['source_datasets', 's'], ['training_datasets', 'd'], ['models', 'm']] as const) {
      // models has no archived_at exposed through this count, but source and training
      // datasets do — both must exclude tombstones so these numbers agree with what
      // actually blocks a delete.
      const deletedFilter = table === 'models' ? '' : ' AND archived_at IS NULL';
      const r = await sql<{ dataset_type_id: string; count: string }>`
        SELECT dataset_type_id, count(*)::text AS count FROM app.${sql.raw(table)}
        WHERE dataset_type_id IS NOT NULL${sql.raw(deletedFilter)} GROUP BY dataset_type_id
      `.execute(exec);
      for (const row of r.rows) {
        const u = usageMap.get(row.dataset_type_id) ?? { s: 0, d: 0, m: 0 };
        u[key] = Number(row.count);
        usageMap.set(row.dataset_type_id, u);
      }
    }

    const byId = new Map(nodes.map((n) => [n.id, n]));
    const childCount = new Map<string, number>();
    for (const n of nodes) {
      if (n.parent_id) childCount.set(n.parent_id, (childCount.get(n.parent_id) ?? 0) + 1);
    }

    const resolveEffectiveBasePath = (n: (typeof nodes)[number]): { dataset_path: string; inherited: boolean; inherited_from_dataset_type_id: string } | null => {
      let cur: (typeof nodes)[number] | undefined = n;
      let inherited = false;
      while (cur) {
        if (cur.dataset_path) {
          return { dataset_path: cur.dataset_path, inherited, inherited_from_dataset_type_id: cur.id };
        }
        inherited = true;
        cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
      }
      return null;
    };

    const effectiveEnabled = (n: (typeof nodes)[number]): boolean => {
      let cur: (typeof nodes)[number] | undefined = n;
      while (cur) {
        if (!cur.enabled) return false;
        cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
      }
      return true;
    };

    const toNode = (n: (typeof nodes)[number]): Record<string, unknown> => {
      const u = usageMap.get(n.id) ?? { s: 0, d: 0, m: 0 };
      return {
        id: n.id,
        name: n.name,
        parent_id: n.parent_id,
        icon: n.icon,
        color: n.color,
        enabled: n.enabled,
        effective_enabled: effectiveEnabled(n),
        is_system: n.is_system,
        sort_order: n.sort_order,
        dataset_path: n.dataset_path,
        model_path: n.model_path,
        training_dataset_path: n.training_dataset_path,
        row_version: n.row_version,
        effective_dataset_path: resolveEffectiveBasePath(n),
        usage: {
          source_dataset_count: u.s,
          dataset_count: u.d,
          model_count: u.m,
          direct_child_count: childCount.get(n.id) ?? 0,
        },
        children: [] as Record<string, unknown>[],
      };
    };

    const built = new Map<string, Record<string, unknown>>();
    for (const n of nodes) built.set(n.id, toNode(n));

    const rootsOut: Record<string, unknown>[] = [];
    for (const n of nodes) {
      const node = built.get(n.id)!;
      if (n.parent_id && built.has(n.parent_id)) {
        (built.get(n.parent_id)!.children as Record<string, unknown>[]).push(node);
      } else {
        rootsOut.push(node);
      }
    }

    const sortRec = (arr: Record<string, unknown>[]) => {
      arr.sort((a, b) =>
        (a.sort_order as number) - (b.sort_order as number) ||
        String(a.name).localeCompare(String(b.name)),
      );
      for (const x of arr) sortRec(x.children as Record<string, unknown>[]);
    };
    sortRec(rootsOut);
    return rootsOut;
  }
}
