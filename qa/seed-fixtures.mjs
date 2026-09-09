#!/usr/bin/env node
/**
 * Generate the fixtures qa/run.mjs, qa/obb-e2e.mjs and qa/built-detect-e2e.mjs read.
 *
 * They are generated rather than committed because they are bulk: six datasets of the
 * same handful of images comes to tens of megabytes, and none of it is interesting —
 * what matters is the label geometry, which is a few hundred bytes. Generating also
 * keeps them honest, since a fixture nobody can rebuild drifts from what the tests
 * think it contains.
 *
 * The images are written here rather than copied from anywhere, so this needs no data
 * of its own: a PNG is a signature, three chunks and a zlib stream, which node can do
 * with nothing installed.
 *
 *   node qa/seed-fixtures.mjs            # writes deploy/qa-data
 *   node qa/seed-fixtures.mjs --force    # replaces it if it already exists
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'qa-data');
const FORCE = process.argv.includes('--force');

// ---------------------------------------------------------------- PNG writing
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}

/** A solid RGB PNG. Size matters — the scanner records real dimensions. */
function png(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3;
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- label shapes
/** An axis-aligned box, as DETECT wants it: cls cx cy w h. */
const detect = (cls, cx, cy, w, h) =>
  `${cls} ${[cx, cy, w, h].map((v) => v.toFixed(6)).join(' ')}`;

/** The same box rotated, as OBB wants it: cls x1 y1 … x4 y4, clockwise. */
function obb(cls, cx, cy, w, h, radians) {
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
    .map(([x, y]) => [cx + x * cos - y * sin, cy + x * sin + y * cos]);
  return `${cls} ${pts.flat().map((v) => v.toFixed(6)).join(' ')}`;
}

// Five images per dataset, each with a couple of boxes at stable positions — the
// tests assert on status and counts, never on where a box happens to be.
const SHAPES = [
  { cls: 0, cx: 0.30, cy: 0.35, w: 0.18, h: 0.12, rot: 0.35 },
  { cls: 1, cx: 0.68, cy: 0.60, w: 0.22, h: 0.14, rot: -0.6 },
];
const IMAGES = 5;

function labelsFor(kind, i) {
  const rows = SHAPES.map((s, j) => {
    if (kind === 'detect') return detect(s.cls, s.cx, s.cy, s.w, s.h);
    const row = obb(s.cls, s.cx, s.cy, s.w, s.h, s.rot + i * 0.1);
    return kind === 'confidence' ? `${row} 1.000000` : row;
  });
  // One dataset carries a deliberately broken row, one a non-finite coordinate:
  // both must be refused, and a test that cannot produce them proves nothing.
  if (kind === 'degenerate' && i === 2) rows.push('0 0.4 0.4 0.4 0.4 0.4 0.4 0.4 0.4');
  if (kind === 'nan' && i === 3) rows.push('0 nan 0.1 0.5 0.1 0.5 0.5 0.1 0.5');
  return rows.join('\n') + '\n';
}

function writeDataset(dir, kind) {
  mkdirSync(join(dir, 'images'), { recursive: true });
  mkdirSync(join(dir, 'labels'), { recursive: true });
  for (let i = 1; i <= IMAGES; i++) {
    const stem = `img_${String(i).padStart(3, '0')}`;
    writeFileSync(join(dir, 'images', `${stem}.png`), png(160, 120, [20, 40 + i * 8, 90]));
    writeFileSync(join(dir, 'labels', `${stem}.txt`), labelsFor(kind, i));
  }
  writeFileSync(join(dir, 'classes.txt'), 'car\ntruck\n');
}

/** A prepared YOLO directory, which a registered training dataset points straight at. */
function writeRegistered(dir, poisonRow, kind = 'obb') {
  for (const split of ['train', 'val']) {
    mkdirSync(join(dir, 'images', split), { recursive: true });
    mkdirSync(join(dir, 'labels', split), { recursive: true });
  }
  for (let i = 1; i <= IMAGES; i++) {
    const stem = `img_${String(i).padStart(3, '0')}`;
    const split = i <= 3 ? 'train' : 'val';
    writeFileSync(join(dir, 'images', split, `${stem}.png`), png(160, 120, [30, 60, 100 + i * 6]));
    let rows = labelsFor(kind, i);
    // Deep inside the second file, so a scan that samples one row cannot find it.
    if (poisonRow && i === 2) rows += poisonRow + '\n';
    writeFileSync(join(dir, 'labels', split, `${stem}.txt`), rows);
  }
  writeFileSync(join(dir, 'data.yaml'),
    `path: /data/training-datasets/${dir.split('/').pop()}\ntrain: images/train\nval: images/val\nnames:\n  0: car\n  1: truck\n`);
}

// ---------------------------------------------------------------------- write
if (existsSync(ROOT)) {
  if (!FORCE) { console.error(`${ROOT} exists — pass --force to replace it`); process.exit(1); }
  rmSync(ROOT, { recursive: true, force: true });
}

const SOURCES = {
  vehicles: 'detect',              // the DETECT pair the build merges
  'vehicles-b': 'detect',
  'obb-good': 'obb',               // must scan clean
  'obb-degenerate': 'degenerate',  // must be refused: corners enclosing no area
  'obb-nan': 'nan',                // must be refused: a non-finite coordinate
  'obb-with-confidence': 'confidence', // must scan, and the build must strip the column
};
for (const [name, kind] of Object.entries(SOURCES)) {
  writeDataset(join(ROOT, 'source-datasets', name), kind);
}
writeRegistered(join(ROOT, 'training-datasets', 'registered-ok'), null, 'obb');
writeRegistered(join(ROOT, 'training-datasets', 'registered-bad'), '0 0.5 0.5 0.2 0.2', 'obb');
// The registered path was only ever exercised with OBB, but it validates DETECT by
// the same rules and with a different field count.
writeRegistered(join(ROOT, 'training-datasets', 'registered-detect'), null, 'detect');
// The workers write into these; they must exist and be writable before a run.
for (const d of ['models', 'training-datasets/datasets']) mkdirSync(join(ROOT, d), { recursive: true });

console.log(`wrote ${ROOT}`);
console.log(`  source datasets    : ${Object.keys(SOURCES).join(', ')}`);
console.log('  training datasets  : registered-ok, registered-bad, registered-detect');
