import { readdirSync, realpathSync, statSync } from 'fs';
import { resolve, join, relative, isAbsolute, sep } from 'path';
import { Inject, Injectable, HttpException } from '@nestjs/common';
import { DB_PROVIDER } from '../../database/database.module';
import { type Kysely, sql } from 'kysely';
import type { Database } from '@model-trainer/db';
import { errorCode } from '@model-trainer/shared-types';
import { DatasetTypesTreeService } from '../dataset-types/dataset-types-tree.service';
import { normalizeRoot, nestedRootsWithin } from '../../common/roots';

const err = (code: string, message: string, status: number) =>
  new HttpException({ error: { code, message, requestId: '' } }, status);

export interface BrowseResult {
  folders: string[];
  files: string[];
  currentPath: string;
  basePath: string;
  parent: string | null;
  /**
   * Directories in this listing that are another dataset type's root, with the type that
   * owns them. They are kept out of `folders` so nothing here can be selected for the
   * wrong type, and reported separately so the browser can say why a folder that plainly
   * exists on disk is not offered.
   */
  delegated?: { name: string; ownerName: string }[];
}

@Injectable()
export class BrowseService {
  constructor(
    @Inject(DB_PROVIDER) private readonly db: Kysely<Database>,
    private readonly tree: DatasetTypesTreeService,
  ) {}

  /**
   * Lists a directory by absolute path, for choosing the roots themselves (a dataset
   * type's paths do not exist yet at that point, so the type-scoped browse cannot be
   * used). Opens at `/` and browses anywhere on the host. Admin-only endpoint.
   */
  async browseAbsolute(requestedPath: string): Promise<BrowseResult> {
    const target = requestedPath ? resolve(requestedPath) : '/';

    const empty: BrowseResult = { folders: [], files: [], currentPath: '/', basePath: '/', parent: null };
    try {
      if (!statSync(target).isDirectory()) return empty;
    } catch {
      return empty;
    }

    let parent: string | null = null;
    if (target !== '/') {
      parent = resolve(target, '..');
    }

    const folders: string[] = [];
    const files: string[] = [];
    try {
      for (const entry of readdirSync(target, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) folders.push(entry.name);
        else if (entry.isFile()) files.push(entry.name);
      }
    } catch { /* unreadable directory */ }

    folders.sort();
    files.sort();
    return { folders, files, currentPath: target, basePath: '/', parent };
  }

  /**
   * Report what a manually typed absolute path actually is on disk.
   *
   * The picker can only produce valid paths, but the field next to it is free text, and
   * a dataset type whose root does not exist fails much later — at scan or build time,
   * from a worker, with a much worse error. This is the cheap check up front.
   *
   * Callers are expected to have already rejected malformed input client-side; this only
   * answers questions that need the filesystem. Admin-only endpoint, so no root
   * confinement.
   *
   * Deliberately reports no writability verdict, unlike the equivalent check in Dataset
   * Manager. There, the process doing the check is also the one that writes. Here the
   * API mounts DATA_ROOT `:ro` in compose (Source is read-only by rule, and the API
   * has no business writing anywhere else) while the workers mount it read-write —
   * so an access check here describes the wrong process and would fail every
   * genuinely valid path.
   */
  validateAbsolute(requestedPath: string): {
    status: 'ok' | 'missing' | 'not_a_directory' | 'outside_root';
    basePath: string;
  } {
    const target = resolve(requestedPath);
    let stat;
    try {
      stat = statSync(target);
    } catch {
      return { status: 'missing', basePath: '/' };
    }
    if (!stat.isDirectory()) return { status: 'not_a_directory', basePath: '/' };
    return { status: 'ok', basePath: '/' };
  }

  /**
   * Lists one directory under a dataset type's root, never above it.
   *
   * `root` picks which of the type's two roots to browse: 'source' (default) for the
   * read-only source-dataset area, 'training' for the training-dataset area a registered
   * dataset points into.
   */
  async browse(
    datasetTypeId: string,
    requestedPath: string,
    root: 'source' | 'training' = 'source',
  ): Promise<BrowseResult> {
    const typeRow = await this.db.selectFrom('dataset_types').select(['enabled', 'training_dataset_path'])
      .where('id', '=', datasetTypeId).executeTakeFirst();
    if (!typeRow) throw err(errorCode.DATASET_TYPE_NOT_FOUND, 'dataset type not found', 404);

    let basePath: string;
    if (root === 'training') {
      if (!typeRow.training_dataset_path) {
        throw err(errorCode.TRAINING_DATASET_PATH_INVALID, 'dataset type has no training_dataset_path', 400);
      }
      basePath = typeRow.training_dataset_path;
    } else {
      const eff = await this.tree.effectiveBasePath(this.db, datasetTypeId);
      if (!eff) {
        throw err(errorCode.SOURCE_DATASET_DATASET_TYPE_INVALID, 'dataset type has no dataset_path (direct or inherited)', 400);
      }
      basePath = eff.dataset_path;
    }

    let browsePath: string;
    if (requestedPath && isAbsolute(requestedPath)) {
      browsePath = requestedPath;
    } else if (requestedPath) {
      browsePath = join(basePath, requestedPath);
    } else {
      browsePath = basePath;
    }

    const resolved = resolve(browsePath);
    const rel = relative(basePath, resolved);
    const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    const safePath = inside ? resolved : basePath;

    const empty: BrowseResult = { folders: [], files: [], currentPath: basePath, basePath, parent: null };

    try {
      if (!statSync(safePath).isDirectory()) return empty;
    } catch {
      return empty;
    }

    let parent: string | null = null;
    if (safePath !== basePath) {
      const parentDir = resolve(safePath, '..');
      const parentRel = relative(basePath, parentDir);
      if (parentRel === '' || (!parentRel.startsWith('..') && !isAbsolute(parentRel))) {
        parent = parentDir;
      }
    }

    // Roots belonging to other types that sit inside the one being browsed. Their
    // contents belong to the deeper type, so this browser must not offer them: a
    // directory picked here becomes a training dataset's relative_path, and picking one
    // would file another type's dataset under this one.
    const owners = await this.otherRootsWithin(datasetTypeId, basePath, root);

    const folders: string[] = [];
    const files: string[] = [];
    const delegated: { name: string; ownerName: string }[] = [];
    try {
      for (const entry of readdirSync(safePath, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = join(safePath, entry.name);
        try {
          if (entry.isSymbolicLink()) continue;
          const real = realpathSync(full);
          const realRel = relative(basePath, real);
          if (realRel.startsWith('..') || isAbsolute(realRel)) continue;
          if (statSync(full).isDirectory()) {
            const owner = owners.get(normalizeRoot(full));
            if (owner) delegated.push({ name: entry.name, ownerName: owner });
            else folders.push(entry.name);
          } else if (entry.isFile()) files.push(entry.name);
        } catch { /* skip inaccessible */ }
      }
    } catch { /* permission error etc */ }

    folders.sort();
    files.sort();
    delegated.sort((a, b) => a.name.localeCompare(b.name));
    return {
      folders, files, currentPath: safePath, basePath, parent,
      ...(delegated.length ? { delegated } : {}),
    };
  }

  /** normalized root path -> owning dataset type name, for roots strictly inside `basePath`. */
  private async otherRootsWithin(
    datasetTypeId: string, basePath: string, root: 'source' | 'training',
  ): Promise<Map<string, string>> {
    const column = root === 'training' ? 'training_dataset_path' : 'dataset_path';
    const rows = await this.db.selectFrom('dataset_types')
      .select(['name', column])
      .where('id', '!=', datasetTypeId)
      .where(column, 'is not', null)
      .execute();
    const others = rows.map((r) => ({
      path: (r as Record<string, string>)[column],
      name: r.name,
    }));
    return new Map(
      nestedRootsWithin(basePath, others).map((o) => [normalizeRoot(o.path), o.name]),
    );
  }
}
