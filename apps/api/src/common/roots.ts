/**
 * Overlap rules for the per-dataset-type filesystem roots.
 *
 * A dataset type owns three roots (`dataset_path`, `model_path`, `training_dataset_path`)
 * and nothing stops an admin from putting one type's root inside another's — grouping
 * every type under a shared parent is a perfectly reasonable layout. What breaks is the
 * assumption that "under type X's root" means "belongs to type X": once roots nest, the
 * enclosing type sees the deeper type's directories as its own.
 *
 * The rule everywhere is the same: **the deepest root owns a path.** Enclosing types
 * stop at a nested root instead of claiming what is inside it.
 *
 * `model_path` is the one root that must not overlap at all — it is scanned recursively
 * and auto-registers what it finds, so an enclosing root would silently take ownership of
 * checkpoints the admin never pointed it at. The other two are only ever browsed or
 * addressed by an explicit relative path, so nesting there is allowed and simply
 * delegated.
 */

/** Trailing slashes and stray whitespace must not change what a root means. */
export function normalizeRoot(p: string): string {
  const trimmed = p.trim().replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

export type RootRelation = 'same' | 'inside' | 'contains' | null;

/** How `a` sits relative to `b`, from a's point of view. `null` when they are disjoint. */
export function rootRelation(a: string, b: string): RootRelation {
  const x = normalizeRoot(a);
  const y = normalizeRoot(b);
  if (x === y) return 'same';
  if (x.startsWith(`${y}/`)) return 'inside';
  if (y.startsWith(`${x}/`)) return 'contains';
  return null;
}

/**
 * The subset of `others` that lives strictly inside `base` — the roots `base` must not
 * claim. Equal paths are excluded: neither is more specific, so neither delegates.
 */
export function nestedRootsWithin<T extends { path: string }>(base: string, others: T[]): T[] {
  return others.filter((o) => rootRelation(o.path, base) === 'inside');
}

/** True when `absolutePath` is at or below `root`. */
export function isWithinRoot(absolutePath: string, root: string): boolean {
  const p = normalizeRoot(absolutePath);
  const r = normalizeRoot(root);
  return p === r || p.startsWith(`${r}/`);
}

/**
 * DATA_ROOT is a comma-separated list of one or more host paths, each bind-mounted at
 * the same absolute path into every service that needs it (see docker-compose.yml +
 * gen-roots-compose.sh). Whitespace around entries is ignored; empty entries are dropped.
 */
export function getDataRoots(): string[] {
  return (process.env.DATA_ROOT || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
