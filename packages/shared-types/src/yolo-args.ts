import { YOLO_ARGS, type YoloArgSpec } from './yolo-args.generated';

export { YOLO_ARGS, ULTRALYTICS_VERSION } from './yolo-args.generated';
export type { YoloArgSpec } from './yolo-args.generated';
/**
 * Arguments the platform owns. A job that could set these could read or write outside
 * its own workspace (`data`, `project`, `save_dir`), silently train something other than
 * the selected dataset, or resume from an unrelated run — so they are rejected rather
 * than quietly dropped, which would leave the CLI showing a value that never applied.
 */
export const RESERVED_YOLO_ARGS: Record<string, string> = {
  data: 'the training dataset is chosen in the wizard',
  model: 'the base model is chosen in the wizard',
  project: 'the output directory is managed by the worker',
  name: 'the run directory is managed by the worker',
  save_dir: 'the output directory is managed by the worker',
  exist_ok: 'the worker manages its own run directory',
  resume: 'resuming another run is not supported',
  mode: 'always train',
  task: 'derived from the training dataset',
};

export interface YoloArgIssue {
  key: string;
  message: string;
  /** Closest known argument, when the key looks like a typo. */
  suggestion?: string;
}

/** Levenshtein, for did-you-mean on an unknown key. */
function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function suggest(key: string, pool: string[] = Object.keys(YOLO_ARGS)): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const candidate of pool) {
    const d = distance(key, candidate);
    if (d < bestD) { bestD = d; best = candidate; }
  }
  // Only offer a correction close enough to be plausible.
  return bestD <= Math.max(2, Math.floor(key.length / 3)) ? best : undefined;
}

function checkValue(key: string, spec: YoloArgSpec, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (key === 'imgsz') return checkImgsz(value);
  switch (spec.kind) {
    case 'bool':
      return typeof value === 'boolean' ? null : `must be true or false, got ${JSON.stringify(value)}`;
    case 'int': {
      const n = Number(value);
      if (typeof value === 'boolean' || !Number.isFinite(n)) return `must be a number, got ${JSON.stringify(value)}`;
      return Number.isInteger(n) ? null : `must be a whole number, got ${n}`;
    }
    case 'fraction': {
      const n = Number(value);
      if (typeof value === 'boolean' || !Number.isFinite(n)) return `must be a number, got ${JSON.stringify(value)}`;
      // Mirrors Ultralytics check_cfg, which allows the whole closed interval here.
      return n >= 0 && n <= 1 ? null : `must be between 0.0 and 1.0, got ${n}`;
    }
    case 'float': {
      const n = Number(value);
      if (typeof value === 'boolean' || !Number.isFinite(n)) return `must be a number, got ${JSON.stringify(value)}`;
      return null;
    }
    default:
      return null; // strings/paths/nullable knobs: the key itself is the only check
  }
}

/** `imgsz` is a single int (square) or a [height, width] pair (rectangular) — mirrors
 * Ultralytics `check_imgsz`. */
function checkImgsz(value: unknown): string | null {
  if (Array.isArray(value)) {
    if (value.length !== 2) return `must be a number or a [height, width] pair, got ${JSON.stringify(value)}`;
    for (const v of value) {
      const n = Number(v);
      if (typeof v === 'boolean' || !Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        return `must be a positive whole number, got ${JSON.stringify(v)}`;
      }
    }
    return null;
  }
  const n = Number(value);
  if (typeof value === 'boolean' || !Number.isFinite(n)) return `must be a number, got ${JSON.stringify(value)}`;
  return Number.isInteger(n) && n > 0 ? null : `must be a positive whole number, got ${n}`;
}

/**
 * Validate a hyperparameter map against the Ultralytics argument spec.
 *
 * Deliberately mirrors — never replaces — the worker's `check_cfg` call. This runs in
 * the browser and the API so bad input is caught before a job is queued; the worker
 * re-checks against the Ultralytics actually installed, which is what finally counts.
 */
export function validateYoloArgs(
  args: Record<string, unknown>,
  opts: { allowReserved?: boolean } = {},
): YoloArgIssue[] {
  const issues: YoloArgIssue[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (!opts.allowReserved && key in RESERVED_YOLO_ARGS) {
      issues.push({ key, message: `set by the platform — ${RESERVED_YOLO_ARGS[key]}` });
      continue;
    }
    const spec = YOLO_ARGS[key];
    if (!spec) {
      issues.push({ key, message: 'not a YOLO training argument', suggestion: suggest(key) });
      continue;
    }
    const problem = checkValue(key, spec, value);
    if (problem) issues.push({ key, message: problem });
  }
  return issues;
}

/**
 * Argument spec for `Model.export()`, which differs from the training set (`simplify`,
 * `opset`… are not training arguments). Mirrors the worker's whitelist (ultralytics
 * `DEFAULT_CFG_DICT` ∩ export params) — `half`/`fp16`/`int8` are NOT valid here, so a
 * conversion that passes them would fail on the worker. A key that is only a training
 * argument (e.g. `epochs`) is also rejected for exports.
 */
export const EXPORT_ARGS: Record<string, YoloArgSpec> = {
  format: { kind: 'other', default: 'openvino' },
  imgsz: { kind: 'other', default: 640 },
  dynamic: { kind: 'bool', default: false },
  simplify: { kind: 'bool', default: false },
  nms: { kind: 'bool', default: false },
  keras: { kind: 'bool', default: false },
  optimize: { kind: 'bool', default: false },
  end2end: { kind: 'bool', default: false },
  augment: { kind: 'bool', default: false },
  val: { kind: 'bool', default: true },
  verbose: { kind: 'bool', default: true },
  opset: { kind: 'int', default: null },
  batch: { kind: 'int', default: 1 },
  max_det: { kind: 'int', default: null },
  vid_stride: { kind: 'int', default: 1 },
  workspace: { kind: 'float', default: null },
  device: { kind: 'other', default: null },
};

/** Validate a conversion argument map against the Ultralytics export spec. */
export function validateExportArgs(
  args: Record<string, unknown>,
  opts: { allowReserved?: boolean } = {},
): YoloArgIssue[] {
  const issues: YoloArgIssue[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (!opts.allowReserved && key in RESERVED_YOLO_ARGS) {
      issues.push({ key, message: `set by the platform — ${RESERVED_YOLO_ARGS[key]}` });
      continue;
    }
    const spec = EXPORT_ARGS[key];
    if (!spec) {
      issues.push({ key, message: 'not an export argument', suggestion: suggest(key, Object.keys(EXPORT_ARGS)) });
      continue;
    }
    const problem = checkValue(key, spec, value);
    if (problem) issues.push({ key, message: problem });
  }
  return issues;
}

/**
 * Parse a `yolo train k=v ...` command into an argument map.
 *
 * Only `k=v` tokens are read, so `yolo`, `train`, comments and line-continuation
 * backslashes can be reordered or dropped freely. Unparsed keys are still reported so a
 * typo like `epochs 10` is not silently ignored.
 */
export function parseYoloCli(cli: string): { args: Record<string, unknown>; strayTokens: string[] } {
  const args: Record<string, unknown> = {};
  const strayTokens: string[] = [];
  const cleaned = cli.replace(/\\\s*\n/g, ' ').replace(/#[^\n]*/g, ' ');
  for (const raw of cleaned.split(/\s+/)) {
    const token = raw.trim();
    if (!token) continue;
    if (token === 'yolo' || token === 'train' || token === 'export' || token === 'detect' || token === 'obb') continue;
    if (!token.includes('=')) { strayTokens.push(token); continue; }
    const [key, ...rest] = token.split('=');
    const value = rest.join('=');
    if (!key) { strayTokens.push(token); continue; }
    if (value === '') { args[key] = ''; continue; }
    if (key === 'imgsz' && value.includes(',')) {
      const parts = value.split(',').map((v) => Number(v.trim()));
      args[key] = parts.every((n) => Number.isFinite(n)) ? parts : value;
      continue;
    }
    if (value === 'True' || value === 'true') args[key] = true;
    else if (value === 'False' || value === 'false') args[key] = false;
    else if (value === 'None' || value === 'null') args[key] = null;
    else if (!Number.isNaN(Number(value))) args[key] = Number(value);
    else args[key] = value;
  }
  return { args, strayTokens };
}

/** Keys the wizard consumes to pick weights; they are not Ultralytics arguments. */
const WIZARD_ONLY_KEYS = new Set(['yolo_version', 'yolo_size']);

/** How a value is written in a `yolo` command: Python casing for booleans and None. */
function formatYoloValue(v: unknown): string {
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (v === null || v === undefined) return 'None';
  if (Array.isArray(v)) return v.join(',');
  return String(v);
}

/**
 * Render the `yolo train …` command a stored hyperparameter set corresponds to.
 *
 * Used to show, after the fact, what a finished job actually ran. `data` and the output
 * directory are supplied by the platform rather than stored in hyperparameters, so they
 * are passed in — a command without them would not be runnable, which defeats the point
 * of showing it.
 *
 * Ordering is deliberate and stable: the two arguments that decide *what* is trained,
 * then the three everyone looks for, then the remaining overrides alphabetically. The
 * same input always produces the same text, so it diffs cleanly between two runs.
 */
export function buildYoloCommand(
  hyperparameters: Record<string, unknown>,
  context: { data?: string | null; model?: string | null } = {},
): string {
  const hp = { ...hyperparameters };
  for (const k of WIZARD_ONLY_KEYS) delete hp[k];

  const model = context.model ?? hp.model;
  delete hp.model;

  // "yolo train" is one clause; only the arguments get their own continuation lines.
  const parts: string[] = ['yolo train'];
  if (model) parts.push(`model=${formatYoloValue(model)}`);
  if (context.data) parts.push(`data=${formatYoloValue(context.data)}`);
  for (const k of ['epochs', 'imgsz', 'batch']) {
    if (hp[k] !== undefined) { parts.push(`${k}=${formatYoloValue(hp[k])}`); delete hp[k]; }
  }
  for (const k of Object.keys(hp).sort()) parts.push(`${k}=${formatYoloValue(hp[k])}`);
  return parts.join(' \\\n  ');
}
