import * as fs from 'fs';
import * as path from 'path';
import type { DatasetTaskType } from '@model-trainer/db';

export interface LabelGeometryExample {
  geometry: DatasetTaskType;
  file: string;
  line: number;
}

export interface LabelGeometryInspection {
  geometry: DatasetTaskType | 'MIXED' | null;
  detectRows: number;
  obbRows: number;
  examples: LabelGeometryExample[];
}

/**
 * The inspection as an error `details` payload. `err()` takes a `Record<string, unknown>`,
 * which an interface does not satisfy without an index signature, so widen it here rather
 * than loosening the interface every caller reads.
 */
export function geometryDetails(inspection: LabelGeometryInspection): Record<string, unknown> {
  return { ...inspection };
}

function rowGeometry(line: string): DatasetTaskType | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6 && parts.length !== 9 && parts.length !== 10) return null;
  const values = parts.map(Number);
  if (values.some((value) => !Number.isFinite(value))) return null;
  if (!Number.isInteger(values[0]) || values[0] < 0) return null;
  const expected = parts.length <= 6 ? 5 : 9;
  if (parts.length === expected + 1 && (values[expected] < 0 || values[expected] > 1)) return null;
  return expected === 5 ? 'DETECT' : 'OBB';
}

async function labelFiles(root: string, allowSubdirectories: boolean): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string, relativeDir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (allowSubdirectories) await walk(path.join(dir, entry.name), relative);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.txt') {
        files.push(relative);
      }
    }
  }
  await walk(root, '');
  return files.sort();
}

export async function inspectLabelGeometry(
  datasetDir: string,
  labelsRelativePath: string,
  allowSubdirectories: boolean,
  exampleLimit = 8,
): Promise<LabelGeometryInspection> {
  const labelsDir = path.join(datasetDir, labelsRelativePath);
  const files = await labelFiles(labelsDir, allowSubdirectories);
  let detectRows = 0;
  let obbRows = 0;
  const examples: LabelGeometryExample[] = [];

  for (const file of files) {
    let text: string;
    try {
      text = await fs.promises.readFile(path.join(labelsDir, file), 'utf8');
    } catch {
      continue;
    }
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      const geometry = rowGeometry(line);
      if (!geometry) continue;
      if (geometry === 'DETECT') detectRows += 1;
      else obbRows += 1;
      if (examples.length < exampleLimit && !examples.some((example) => example.geometry === geometry)) {
        examples.push({ geometry, file, line: index + 1 });
      }
    }
  }

  const geometry = detectRows > 0 && obbRows > 0
    ? 'MIXED'
    : detectRows > 0
      ? 'DETECT'
      : obbRows > 0
        ? 'OBB'
        : null;
  return { geometry, detectRows, obbRows, examples };
}
