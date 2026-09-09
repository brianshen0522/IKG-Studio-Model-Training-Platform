/**
 * Which official Ultralytics weights exist, as the one place that answers it.
 *
 * The wizard used to keep this on its own and said YOLO12 ships OBB weights, which
 * it does not — the job then built `yolo12n-obb.pt`, found no such release asset and
 * died at PREPARATION with a download error. Nothing on the API side disagreed,
 * because nothing on the API side knew.
 *
 * Checked against GITHUB_ASSETS_NAMES in ultralytics/utils/downloads.py, whose yolo12
 * line carries the comment "detect models only currently".
 */
export type YoloTask = 'DETECT' | 'OBB' | 'SEGMENT' | 'POSE' | 'CLASSIFY';

/** The suffix Ultralytics gives a weight file for each task. */
export const YOLO_TASK_SUFFIX: Record<YoloTask, string> = {
  DETECT: '', OBB: '-obb', SEGMENT: '-seg', POSE: '-pose', CLASSIFY: '-cls',
};

export interface YoloGeneration {
  /** As the wizard and the hyperparameters spell it: v8, v9, v10, v11, v12, v26. */
  id: string;
  label: string;
  /** v8/v9/v10 keep the "v" in the filename; 11 and later drop it. */
  keepV: boolean;
  /** Scale letters this generation actually published — v9 and v10 differ. */
  sizes: readonly string[];
  /** Tasks with published weights. Everything ships DETECT; the rest varies. */
  tasks: readonly YoloTask[];
}

export const YOLO_GENERATIONS: readonly YoloGeneration[] = [
  { id: 'v8',  label: 'YOLOv8',  keepV: true,  sizes: ['n', 's', 'm', 'l', 'x'],      tasks: ['DETECT', 'OBB'] },
  { id: 'v9',  label: 'YOLOv9',  keepV: true,  sizes: ['t', 's', 'm', 'c', 'e'],      tasks: ['DETECT'] },
  { id: 'v10', label: 'YOLOv10', keepV: true,  sizes: ['n', 's', 'm', 'b', 'l', 'x'], tasks: ['DETECT'] },
  { id: 'v11', label: 'YOLO11',  keepV: false, sizes: ['n', 's', 'm', 'l', 'x'],      tasks: ['DETECT', 'OBB'] },
  { id: 'v12', label: 'YOLO12',  keepV: false, sizes: ['n', 's', 'm', 'l', 'x'],      tasks: ['DETECT'] },
  { id: 'v26', label: 'YOLO26',  keepV: false, sizes: ['n', 's', 'm', 'l', 'x'],      tasks: ['DETECT', 'OBB'] },
] as const;

export const findYoloGeneration = (id: string): YoloGeneration | undefined =>
  YOLO_GENERATIONS.find((g) => g.id === id);

/** The weight filename a generation, size and task resolve to. */
export function officialWeightName(versionId: string, size: string, task: YoloTask): string {
  const g = findYoloGeneration(versionId);
  const stem = g?.keepV === false ? `yolo${versionId.replace(/^v/, '')}${size}` : `yolo${versionId}${size}`;
  return `${stem}${YOLO_TASK_SUFFIX[task] ?? ''}.pt`;
}

/**
 * Why this combination cannot be trained from official weights, or null if it can.
 *
 * Returns a sentence rather than a code because every caller shows it to someone:
 * the wizard beside the picker, the API in a 400. Naming the generations that do
 * work is the part that makes it actionable.
 */
export function officialWeightsProblem(
  versionId: string | null | undefined,
  size: string | null | undefined,
  task: YoloTask,
): string | null {
  if (!versionId || !size) return null;   // nothing chosen yet; other validation covers it
  const g = findYoloGeneration(versionId);
  if (!g) return `${versionId} is not a YOLO generation this platform trains from.`;
  if (!g.sizes.includes(size)) {
    return `${g.label} has no "${size}" scale — it publishes ${g.sizes.join(', ')}.`;
  }
  if (!g.tasks.includes(task)) {
    const able = YOLO_GENERATIONS.filter((x) => x.tasks.includes(task)).map((x) => x.label);
    return `Ultralytics publishes no official ${task} weights for ${g.label}. `
      + `Pick ${able.join(', ')}, or start from a registered model instead.`;
  }
  return null;
}
