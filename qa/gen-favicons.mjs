// Rasterise apps/web/public/favicon.svg into the PNG sizes browsers ask for.
// Run from the repo root after changing the SVG:  node qa/gen-favicons.mjs
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const SVG = new URL('../apps/web/public/favicon.svg', import.meta.url).pathname;
const OUT = new URL('../apps/web/public/', import.meta.url).pathname;
const svg = readFileSync(SVG, 'utf8');
const dataUri = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');

const b = await chromium.launch();
for (const size of [32, 180]) {
  const p = await (await b.newContext({ viewport: { width: size, height: size } })).newPage();
  await p.setContent(`<body style="margin:0"><img src="${dataUri}" style="width:${size}px;height:${size}px;display:block"></body>`);
  await p.waitForTimeout(300);
  const buf = await p.screenshot({ omitBackground: true });
  writeFileSync(OUT + `favicon-${size}.png`, buf);
  console.log(`favicon-${size}.png  ${buf.length}b`);
}
await b.close();
