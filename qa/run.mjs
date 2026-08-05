import { chromium, firefox, webkit } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.QA_URL || 'http://localhost:8080';
const ADMIN_PASSWORD = process.env.QA_ADMIN_PASSWORD || 'admin';
// Paths are host=container absolute paths (see HANDOVER §1.3), so QA has to be told
// where the data roots live rather than guessing a container-local /data.
const DATA_ROOT = process.env.QA_DATA_ROOT || '/Users/brian/Documents/projects/IKG/datas';
// dataset_path is the dataset type's root; discovery walks down to the folders that
// hold images/ + labels/, so the DM archive layout <type>/check/<dataset>/ works.
const QA_SOURCE_PATH = process.env.QA_SOURCE_PATH || `${DATA_ROOT}/datasets/dice`;
const QA_MODEL_PATH = process.env.QA_MODEL_PATH || `${DATA_ROOT}/models/qa`;
const QA_TD_PATH = process.env.QA_TD_PATH || `${DATA_ROOT}/training-datasets/qa`;

const ENGINE = process.env.QA_ENGINE || 'chromium';
const engine = { chromium, firefox, webkit }[ENGINE];
if (!engine) { console.error('unknown QA_ENGINE: ' + ENGINE); process.exit(2); }
const SHOTS = new URL('./shots/' + ENGINE + '/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
// On the dev stack paths are host=container, so QA (running on the host) can prepare
// its own output roots. On the QA stack they are container paths backed by mounts that
// already exist, and mkdir fails harmlessly — hence best-effort.
for (const p of [QA_MODEL_PATH, QA_TD_PATH]) {
  try { mkdirSync(p, { recursive: true }); } catch { /* container-path stack */ }
}

// Setup entities (dataset type, user, source datasets) are reused across runs so the
// smoke test is repeatable without piling up junk. Per-run artifacts (training
// datasets, jobs, runs) get a tag, because building twice under one name would
// collide on the on-disk target directory.
const TAG = new Date().toISOString().slice(2, 16).replace(/[-:T]/g, '');
const DTYPE = 'QA Dice';
const BUILT_DS = `qa-built-${TAG}`;
const REGISTERED_DS = `qa-registered-${TAG}`;
const TRAIN_JOB = `QA Train ${TAG}`;
const BENCH_RUN = `QA Bench ${TAG}`;
// Two sources sharing one classes.txt — merging them exercises the class-compat path
// without tripping the "same index means different things" guard.
const BUILD_SOURCES = (process.env.QA_BUILD_SOURCES || 'sb02_260523,sb02_260531').split(',');

console.log('### ENGINE: ' + ENGINE + '  BASE: ' + BASE + '  TAG: ' + TAG);

const bugs = [];
const netErrors = [];
const consoleErrors = [];
let step = 'init';
function bug(m) { bugs.push(`[${step}] ${m}`); console.log('  ✗ BUG:', m); }
function ok(m) { console.log('  ✓', m); }
function skip(m) { console.log('  ~ skip:', m); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await engine.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[${step}] ${m.text()}`); });
page.on('pageerror', (e) => consoleErrors.push(`[${step}] pageerror: ${e.message}`));
page.on('response', (r) => { const s = r.status(); if (s >= 400 && r.url().includes('/api/') && !r.url().endsWith('/auth/me')) netErrors.push(`[${step}] ${s} ${r.request().method()} ${r.url().replace(BASE, '')}`); });

const shot = (n) => page.screenshot({ path: SHOTS + n + '.png', fullPage: true }).catch(() => {});
const modal = () => page.locator('.modal-card');
async function dismissModal() { if (await page.locator('.modal-overlay').count()) { await page.keyboard.press('Escape').catch(() => {}); await sleep(300); } }
async function setField(scope, label, value) {
  const fields = scope.locator('.field');
  const n = await fields.count();
  for (let i = 0; i < n; i++) {
    const f = fields.nth(i);
    // innerText reflects CSS text-transform, so compare case-insensitively. Take the
    // first span only: path fields carry a trailing `.hint` span too.
    const t = (await f.locator('span').first().innerText().catch(() => '')).trim();
    if (t.toLowerCase() === label.toLowerCase()) {
      const el = f.locator('input, select, textarea').first();
      const tag = await el.evaluate((e) => e.tagName.toLowerCase());
      if (tag === 'select') { await el.selectOption({ label: value }).catch(() => el.selectOption(value)); }
      else { await el.fill(String(value)); }
      return true;
    }
  }
  bug(`field not found: "${label}"`);
  return false;
}
/**
 * Pick an <option> whose text merely *contains* `needle`. Several selects decorate the
 * label with counts (e.g. "qa-built-… (DETECT) · T14/V4/Te2 · 54 classes"), so an exact
 * selectOption({label}) can never match.
 */
async function selectContaining(scope, fieldLabel, needle) {
  const fields = scope.locator('.field');
  const n = await fields.count();
  for (let i = 0; i < n; i++) {
    const f = fields.nth(i);
    const t = (await f.locator('span').first().innerText().catch(() => '')).trim();
    if (t.toLowerCase() !== fieldLabel.toLowerCase()) continue;
    const sel = f.locator('select').first();
    const value = await sel.locator('option').evaluateAll(
      (opts, needle) => (opts.find((o) => o.textContent.includes(needle)) || {}).value,
      needle,
    );
    if (!value) { bug(`no option containing "${needle}" in "${fieldLabel}"`); return false; }
    await sel.selectOption(value);
    return true;
  }
  bug(`field not found: "${fieldLabel}"`);
  return false;
}
const clickBtn = (n) => page.getByRole('button', { name: n, exact: true }).click();
// The Notifications nav item carries an unread badge, so its accessible name is
// "Notifications 11" — fall back to a prefix match when the exact name misses.
const nav = async (n) => {
  await dismissModal();
  const exact = page.getByRole('button', { name: n, exact: true });
  if (await exact.count()) await exact.first().click();
  else await page.getByRole('button', { name: new RegExp('^' + n) }).first().click();
  await sleep(600);
};
async function rowBadge(text) { const b = page.locator('tr', { hasText: text }).locator('.badge').first(); return (await b.count()) ? (await b.innerText()).trim() : ''; }
async function pollRow(navName, text, targets, tries = 40, everyMs = 2500) {
  await nav(navName);
  let s = '';
  for (let i = 0; i < tries; i++) {
    // List pages auto-refresh (refetchInterval), so just re-read the badge in place.
    s = await rowBadge(text);
    if (targets.includes(s)) return s;
    await sleep(everyMs);
  }
  return s;
}
/** Hyperparameters live in collapsed <HyperparamSection> accordions. */
async function openHpSection(title) {
  const t = modal().locator('.hp-toggle', { hasText: title }).first();
  if (await t.count()) {
    const open = await t.locator('.hp-caret.open').count();
    if (!open) { await t.click(); await sleep(200); }
  }
}
async function run(label, fn) { step = label; console.log('\n### ' + label); try { await fn(); } catch (e) { bug('threw: ' + (e.message || e).toString().split('\n')[0]); } await shot(label.replace(/[^a-z0-9]+/gi, '_')); await dismissModal(); }

await run('login', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('input[autocomplete="username"]').fill('admin');
  await page.locator('input[autocomplete="current-password"]').fill(ADMIN_PASSWORD);
  await clickBtn('Sign in'); await sleep(1200);
  // Only reachable on a stack whose bootstrap admin still has must_change_password.
  if (await page.getByText('Set a new password').count()) {
    await setField(page, 'Current password', ADMIN_PASSWORD);
    await setField(page, 'New password', ADMIN_PASSWORD);
    await setField(page, 'Confirm new password', ADMIN_PASSWORD);
    await clickBtn('Change password'); await sleep(1500);
    if (await page.getByText('Set a new password').count()) bug('still on change-password'); else ok('password changed');
  }
  if (await page.getByRole('heading', { name: 'Dashboard' }).count()) ok('dashboard shown'); else bug('no dashboard after login');
});

for (const n of ['Source Datasets', 'Training Datasets', 'Models', 'Training', 'Benchmarks', 'Jobs', 'Notifications', 'Admin', 'Home']) {
  await run('nav-' + n, async () => { await nav(n); ok('navigated ' + n); });
}

await run('admin-dataset-type', async () => {
  await nav('Admin'); await page.getByRole('button', { name: 'Dataset Types', exact: true }).click(); await sleep(600);
  if (await page.getByText(DTYPE, { exact: true }).count()) { skip(`${DTYPE} already exists — reusing`); return; }
  await clickBtn('New Root Type');
  await setField(modal(), 'Name', DTYPE);
  // Paths are required since 053 and must be real absolute host paths; without them
  // Create stays disabled and the click hangs.
  await setField(modal(), 'Dataset path (required)', QA_SOURCE_PATH);
  await setField(modal(), 'Model path (required)', QA_MODEL_PATH);
  await setField(modal(), 'Training dataset path (optional)', QA_TD_PATH);
  await modal().getByRole('button', { name: 'Create' }).click(); await sleep(1200);
  if (await page.getByText(DTYPE, { exact: true }).count()) ok('dataset type listed'); else bug('dataset type not listed');
});

await run('admin-user', async () => {
  await page.getByRole('button', { name: 'Users', exact: true }).click(); await sleep(600);
  if (await page.getByText('qauser', { exact: true }).count()) { skip('qauser already exists — reusing'); return; }
  await clickBtn('New User');
  await setField(modal(), 'Username', 'qauser'); await setField(modal(), 'Display name', 'QA User');
  await setField(modal(), 'Role', 'USER'); await setField(modal(), 'Password mode', 'MANUAL');
  await setField(modal(), 'Password', 'qauser');
  await modal().getByRole('button', { name: 'Create' }).click(); await sleep(1000);
  if (await page.getByText('qauser', { exact: true }).count()) ok('user listed'); else bug('user NOT listed');
});

// There is no create dialog: the page lists the folders discovered under each dataset
// type's dataset_path as cards, and registering is one click per unregistered card.
await run('source-dataset', async () => {
  await nav('Source Datasets');
  const group = page.locator('.type-group', { hasText: DTYPE });
  if ((await group.count()) === 0) { bug(`no folder group for ${DTYPE}`); return; }
  const cards = group.locator('.folder-card');
  if ((await cards.count()) === 0) { bug(`no folders discovered under ${QA_SOURCE_PATH}`); return; }
  // Each registration re-renders the grid, so re-query the first unregistered card
  // rather than holding stale handles.
  let registered = 0;
  for (let guard = 0; guard < 20; guard++) {
    const next = group.locator('.folder-card:not(.is-registered)').first();
    if ((await next.count()) === 0) break;
    await next.getByRole('button', { name: 'Register & scan' }).click();
    await sleep(1500);
    registered++;
  }
  if (registered) ok(`registered ${registered} folder(s)`); else skip('all folders already registered');

  for (const name of BUILD_SOURCES) {
    const card = group.locator('.folder-card', { hasText: name }).first();
    let s = '';
    for (let i = 0; i < 25; i++) {
      s = await card.locator('.badge').first().innerText().catch(() => '');
      s = s.trim();
      if (['READY', 'INVALID'].includes(s)) break;
      await sleep(2500);
    }
    if (s === 'READY') ok(`${name} scan READY`); else bug(`${name} scan not READY (last=${s || 'none'})`);
  }
});

// Training Dataset, origin=BUILT: type & origin → details → sources → classes → split.
await run('dataset-build', async () => {
  await nav('Training Datasets'); await clickBtn('New Training Dataset');
  await modal().locator('.type-card', { hasText: DTYPE }).click();
  await modal().locator('.origin-card', { hasText: 'Build from source datasets' }).click();
  await modal().getByRole('button', { name: 'Next' }).click(); await sleep(300);
  // details step — name must match NAME_RE (path-safe)
  await setField(modal(), 'Name', BUILT_DS);
  await modal().locator('.choice', { hasText: 'DETECT' }).click();
  await modal().getByRole('button', { name: 'Next' }).click(); await sleep(500);
  // sources step — pick the two that share a classes.txt so the merge is compatible
  for (const name of BUILD_SOURCES) {
    const row = modal().locator('.check-row', { hasText: name }).first();
    if (await row.count()) await row.locator('input').check();
    else bug(`source ${name} not offered`);
  }
  await modal().getByRole('button', { name: 'Next' }).click(); await sleep(2000);
  // classes step — compatibility is computed server-side; Next stays disabled if not
  if (await modal().locator('.error-banner').count()) bug('classes reported incompatible');
  await modal().getByRole('button', { name: 'Next' }).click(); await sleep(300);
  // split step — preset instead of three raw inputs
  await modal().locator('.choice', { hasText: '70 / 20 / 10' }).click();
  await modal().getByRole('button', { name: 'Create & Build' }).click(); await sleep(2000);
  ok('build submitted (waiting for worker)');
  const s = await pollRow('Training Datasets', BUILT_DS, ['READY', 'INVALID'], 25);
  if (s === 'READY') ok('built dataset READY'); else bug(`built dataset ended ${s}`);
});

// Training Dataset, origin=REGISTERED: the build worker just wrote a directory under
// this type's training-dataset root, so registering it exercises validation against
// real on-disk output.
await run('dataset-register', async () => {
  await nav('Training Datasets'); await clickBtn('New Training Dataset');
  await modal().locator('.type-card', { hasText: DTYPE }).click();
  await modal().locator('.origin-card', { hasText: 'Register an existing directory' }).click();
  await modal().getByRole('button', { name: 'Next' }).click(); await sleep(300);
  await setField(modal(), 'Name', REGISTERED_DS);
  await modal().locator('.choice', { hasText: 'DETECT' }).click();
  await modal().getByRole('button', { name: 'Next' }).click(); await sleep(300);
  await modal().getByRole('button', { name: 'Browse…' }).click(); await sleep(1000);
  // Descend into datasets/<name>-<uuid8>, which is where the build published.
  const intoDatasets = page.locator('.fb-item', { hasText: 'datasets' }).first();
  if (await intoDatasets.count()) { await intoDatasets.click(); await sleep(800); }
  const built = page.locator('.fb-item', { hasText: BUILT_DS }).first();
  if (await built.count()) { await built.click(); await sleep(800); }
  else bug(`built directory for ${BUILT_DS} not found in browser`);
  await page.getByRole('button', { name: 'Select This Folder' }).click(); await sleep(500);
  await modal().getByRole('button', { name: 'Register & Validate' }).click(); await sleep(2000);
  const s = await pollRow('Training Datasets', REGISTERED_DS, ['READY', 'INVALID'], 20);
  if (s === 'READY') ok('registered dataset READY'); else bug(`registered dataset ended ${s}`);
});

// Import Model is gone — models are discovered by scanning each type's Model Root.
await run('model-scan', async () => {
  await nav('Models'); await clickBtn('Scan Model Roots'); await sleep(2000);
  if (await page.locator('.success-banner').count()) ok('scan dispatched');
  else bug('no confirmation after Scan Model Roots');
});

// Wizard order: Dataset Type → Model → Training Dataset → Hyperparameters → Review & CLI.
// Official YOLO weights are used, so this no longer depends on a registered model.
await run('training', async () => {
  await nav('Training'); await clickBtn('New Training Job');
  await modal().locator('.type-card', { hasText: DTYPE }).click();
  await modal().getByRole('button', { name: 'Next' }).click(); await sleep(300);
  await modal().locator('.origin-card', { hasText: 'Official YOLO model' }).click(); await sleep(200);
  // Scope to each field: the size labels are single letters, so an unscoped hasText
  // match would also hit version notes like "newest, attention-centric".
  await modal().locator('.field', { hasText: 'Version' }).locator('.choice', { hasText: 'YOLO11' }).first().click();
  await modal().locator('.field', { hasText: 'Model size' }).locator('.choice').first().click();
  await modal().getByRole('button', { name: 'Next' }).click(); await sleep(500);
  await selectContaining(modal(), 'Training dataset', BUILT_DS);
  await setField(modal(), 'Job name', TRAIN_JOB);
  await modal().getByRole('button', { name: 'Next' }).click(); await sleep(500);
  await openHpSection('Basic');
  await setField(modal(), 'Epochs', '1');
  await setField(modal(), 'Image size', '32');
  await setField(modal(), 'Batch', '4');
  await modal().getByRole('button', { name: 'Next' }).click(); await sleep(500);
  // Review & CLI — the command is editable and drives the submitted job
  const cli = modal().locator('.cli-editor').first();
  if (await cli.count()) {
    const text = await cli.inputValue().catch(() => '');
    if (text.includes('epochs=1')) ok('CLI reflects hyperparameters'); else bug(`CLI missing epochs=1: ${text.slice(0, 120)}`);
  } else bug('no CLI editor on review step');
  await modal().getByRole('button', { name: 'Create & Submit' }).click(); await sleep(2000);
  const s = await pollRow('Training', TRAIN_JOB, ['COMPLETED', 'FAILED', 'STOPPED'], 60, 3000);
  if (s === 'COMPLETED') ok('training COMPLETED'); else bug('training not COMPLETED (last=' + s + ')');
});

await run('benchmark', async () => {
  await nav('Benchmarks'); await clickBtn('New Benchmark Run');
  await setField(modal(), 'Name', BENCH_RUN); await sleep(1200);
  const m = modal().locator('.check-row', { hasText: TRAIN_JOB }).first();
  if (await m.count()) await m.locator('input').check(); else bug('trained model not offered in benchmark');
  const d = modal().locator('.check-row', { hasText: BUILT_DS }).first();
  if (await d.count()) await d.locator('input').check(); else bug('built dataset not offered in benchmark');
  await modal().getByRole('button', { name: 'Create & Submit' }).click(); await sleep(2000);
  const s = await pollRow('Benchmarks', BENCH_RUN, ['COMPLETED', 'PARTIALLY_FAILED', 'FAILED'], 40, 3000);
  if (s === 'COMPLETED') ok('benchmark COMPLETED'); else bug('benchmark not COMPLETED (last=' + s + ')');
});

await run('training-detail', async () => {
  await nav('Training');
  await page.locator('tr', { hasText: TRAIN_JOB }).first().click(); await sleep(1000);
  if (await page.getByText('← Back').count()) ok('training detail opens'); else bug('training detail did not open');
  if (await page.getByRole('heading', { name: TRAIN_JOB }).count()) ok('detail shows job name'); else bug('detail missing job name');
  if (await page.getByText('Executions').count()) ok('executions section present'); else bug('no executions section');
  await page.getByText('← Back').click().catch(() => {}); await sleep(500);
});

await run('benchmark-detail', async () => {
  await nav('Benchmarks');
  await page.locator('tr', { hasText: BENCH_RUN }).first().click(); await sleep(1000);
  if (await page.getByText('← Back').count()) ok('benchmark detail opens'); else bug('benchmark detail did not open');
  if (await page.getByText('Evaluations').count()) ok('evaluations section present'); else bug('no evaluations section');
  await page.getByText('← Back').click().catch(() => {}); await sleep(500);
});

await run('user-actions', async () => {
  await nav('Admin'); await page.getByRole('button', { name: 'Users', exact: true }).click(); await sleep(600);
  const row = page.locator('tr', { hasText: 'qauser' });
  await row.getByRole('button', { name: 'Disable' }).click(); await sleep(1200);
  if ((await rowBadge('qauser')) === 'DISABLED') ok('user disabled'); else bug('user not disabled (=' + (await rowBadge('qauser')) + ')');
  await row.getByRole('button', { name: 'Enable' }).click(); await sleep(1200);
  if ((await rowBadge('qauser')) === 'ACTIVE') ok('user re-enabled'); else bug('user not re-enabled (=' + (await rowBadge('qauser')) + ')');
});

await run('datasettype-actions', async () => {
  await page.getByRole('button', { name: 'Dataset Types', exact: true }).click(); await sleep(600);
  const row = page.locator('tr', { hasText: DTYPE });
  await row.getByRole('button', { name: 'Disable' }).click(); await sleep(1200);
  if ((await rowBadge(DTYPE)) === 'DISABLED') ok('dataset type disabled'); else bug('dtype not disabled');
  await row.getByRole('button', { name: 'Enable' }).click(); await sleep(1200);
  if ((await rowBadge(DTYPE)) === 'ACTIVE') ok('dataset type re-enabled'); else bug('dtype not re-enabled');
});

// Notifications is a nav page, not a bell-and-panel popover.
await run('notifications', async () => {
  await nav('Notifications');
  if (await page.getByRole('heading', { name: 'Notifications' }).count()) ok('notifications page opens');
  else bug('notifications page did not open');
  const items = await page.locator('tbody tr').count();
  if (items > 0) ok('notifications listed: ' + items); else bug('no notifications listed');
});

await run('logout', async () => {
  await dismissModal();
  await page.getByRole('button', { name: 'Sign Out', exact: true }).click(); await sleep(1200);
  if (await page.locator('input[autocomplete="username"]').count()) ok('logged out to login screen'); else bug('logout did not return to login');
});

console.log('\n==================== QA REPORT ====================');
console.log('BUGS (' + bugs.length + '):'); bugs.forEach((b) => console.log('  - ' + b));
console.log('NET 4xx/5xx (' + [...new Set(netErrors)].length + '):'); [...new Set(netErrors)].forEach((e) => console.log('  - ' + e));
console.log('CONSOLE ERRORS (' + [...new Set(consoleErrors)].length + '):'); [...new Set(consoleErrors)].slice(0, 15).forEach((e) => console.log('  - ' + e));
console.log('==================================================');
await browser.close();
process.exit(0);
