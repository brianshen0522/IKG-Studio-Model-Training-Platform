/**
 * Client-side validation for the absolute paths a dataset type is configured with.
 *
 * Split deliberately into two phases:
 *
 *  - `checkPathFormat` is pure string work and runs here, on every keystroke's blur. A
 *    malformed path can be rejected without troubling the API at all.
 *  - only a format-clean path is worth asking the server about, via
 *    `GET /admin/browse/validate`, which answers the questions that genuinely need the
 *    filesystem (does it exist, is it a directory, is it inside DATA_ROOT).
 *
 * There is deliberately no writability state: the API container mounts these roots
 * read-only while the workers that write to them mount them read-write, so the API
 * cannot answer that question for the process that matters.
 *
 * Paths are host=container absolute paths, so POSIX rules apply on every platform.
 */

export type PathFormatError =
  | 'empty'
  | 'not_absolute'
  | 'has_traversal'
  | 'has_backslash'
  | 'has_control_char'
  | 'trailing_space';

/** Server-answered states, plus the client-side ones the UI shares a slot with. */
export type PathStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'format'; error: PathFormatError }
  | { kind: 'ok' }
  | { kind: 'missing' }
  | { kind: 'not_a_directory' }
  | { kind: 'outside_root'; basePath?: string }
  | { kind: 'unreachable' };

/** Returns null when the path is well-formed. */
export function checkPathFormat(raw: string): PathFormatError | null {
  if (raw.trim() === '') return 'empty';
  // Checked before trimming: a stray space is almost always a paste artefact, and it
  // would silently resolve to a different directory than the one shown.
  if (raw !== raw.trim()) return 'trailing_space';
  if (!raw.startsWith('/')) return 'not_absolute';
  if (raw.includes('\\')) return 'has_backslash';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return 'has_control_char';
  if (raw.split('/').some((seg) => seg === '..')) return 'has_traversal';
  return null;
}

export const PATH_STATUS_MESSAGE: Record<string, string> = {
  empty: 'Path is required',
  not_absolute: 'Must be an absolute path, starting with /',
  has_traversal: 'Must not contain ".." segments',
  has_backslash: 'Must use / as the separator',
  has_control_char: 'Contains an invalid character',
  trailing_space: 'Remove the leading or trailing whitespace',
  missing: 'Directory not found',
  not_a_directory: 'Path exists but is not a directory',
  outside_root: 'Outside the browsable root',
  unreachable: 'Could not check this path',
};

/** The message to show for a status, or null when there is nothing to say. */
export function pathStatusMessage(s: PathStatus): string | null {
  if (s.kind === 'format') return PATH_STATUS_MESSAGE[s.error] ?? 'Invalid path';
  if (s.kind === 'outside_root') {
    return s.basePath ? `Outside the browsable root (${s.basePath})` : PATH_STATUS_MESSAGE.outside_root;
  }
  return PATH_STATUS_MESSAGE[s.kind] ?? null;
}

export const isPathOk = (s: PathStatus) => s.kind === 'ok';
export const isPathBad = (s: PathStatus) =>
  s.kind !== 'idle' && s.kind !== 'checking' && s.kind !== 'ok';
