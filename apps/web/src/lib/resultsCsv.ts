/**
 * Parses Ultralytics' per-epoch `results.csv` (RESULTS_CSV artifact) into named series.
 * Column names carry a task-specific suffix (`metrics/mAP50(B)` for detect, `(M)` for
 * segment, etc.) so columns are matched by prefix rather than exact header text.
 */

const COLUMN_PREFIXES = {
  trainBoxLoss: 'train/box_loss',
  trainClsLoss: 'train/cls_loss',
  valBoxLoss: 'val/box_loss',
  valClsLoss: 'val/cls_loss',
  map50: 'metrics/mAP50(',
  map5095: 'metrics/mAP50-95(',
  precision: 'metrics/precision(',
  recall: 'metrics/recall(',
} as const;

export type ResultsCsvKey = keyof typeof COLUMN_PREFIXES;

export interface ResultsCsvData {
  epochs: number[];
  series: Partial<Record<ResultsCsvKey, number[]>>;
}

export function parseResultsCsv(text: string): ResultsCsvData {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { epochs: [], series: {} };
  const header = lines[0].split(',').map((h) => h.trim());
  const epochCol = header.findIndex((h) => h === 'epoch');
  const colFor: Partial<Record<ResultsCsvKey, number>> = {};
  for (const [key, prefix] of Object.entries(COLUMN_PREFIXES) as [ResultsCsvKey, string][]) {
    const idx = header.findIndex((h) => h.startsWith(prefix));
    if (idx >= 0) colFor[key] = idx;
  }

  const epochs: number[] = [];
  const series: Partial<Record<ResultsCsvKey, number[]>> = {};
  for (const key of Object.keys(colFor) as ResultsCsvKey[]) series[key] = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = lines[i].split(',');
    epochs.push(epochCol >= 0 ? Number(cells[epochCol]) : i);
    for (const key of Object.keys(colFor) as ResultsCsvKey[]) {
      series[key]!.push(Number(cells[colFor[key]!]));
    }
  }
  return { epochs, series };
}
