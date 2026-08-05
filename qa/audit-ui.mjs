import { chromium } from 'playwright';

const BASE = process.env.QA_URL || 'http://localhost:8088';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bugs = [];
const bug = (m) => { bugs.push(m); console.log('  ✗ BUG:', m); };
const ok = (m) => console.log('  ✓', m);

const browser = await chromium.launch();
const page = await browser.newPage();
const netErrors = [];
page.on('response', (r) => {
  const s = r.status();
  if (s >= 400 && r.url().includes('/api/') && !r.url().endsWith('/auth/me')) {
    netErrors.push(`${s} ${r.request().method()} ${r.url().replace(BASE, '')}`);
  }
});
page.on('console', (m) => { if (m.type() === 'error') netErrors.push('console: ' + m.text()); });

try {
  // login
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('input[autocomplete="username"]').fill('admin');
  await page.locator('input[type="password"]').fill('AdminPass123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await sleep(1500);
  ok('logged in');

  // go to Admin -> Audit
  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  await sleep(600);
  await page.getByRole('button', { name: 'Audit', exact: true }).click();
  await sleep(1200);

  const rowCount = await page.locator('table tbody tr').count();
  if (rowCount > 0) ok(`audit list rendered (${rowCount} rows)`); else bug('audit list empty/not rendered');

  // pagination label present
  const hasPager = await page.locator('text=/Page \\d+ \\/ \\d+/').count();
  if (hasPager) ok('pagination shown'); else bug('no pagination label');

  // filter by actionCode = TRAINING_JOB_COMPLETED
  await page.getByPlaceholder('e.g. user.create').fill('TRAINING_JOB_COMPLETED');
  await sleep(1200);
  const filtered = await page.locator('table tbody tr').count();
  const allCompleted = await page.locator('table tbody tr td:nth-child(3)').allInnerTexts();
  if (filtered > 0 && allCompleted.every((t) => t.includes('TRAINING_JOB_COMPLETED')))
    ok(`filter works (${filtered} rows, all TRAINING_JOB_COMPLETED)`);
  else bug(`filter not applied correctly: rows=${filtered} actions=${[...new Set(allCompleted)]}`);

  // open detail modal on first row
  await page.locator('table tbody tr').first().click();
  await sleep(900);
  const modalVisible = await page.locator('.modal-overlay, [class*=modal]').count();
  const hasAction = await page.locator('text=Action').count();
  if (modalVisible && hasAction) ok('detail modal opened with fields'); else bug('detail modal did not open');
  // close
  await page.keyboard.press('Escape');
  await sleep(500);

  // reset filter, open a correlation trace
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await sleep(1000);
  const corrBtns = page.locator('table tbody tr td:last-child button');
  if (await corrBtns.count() > 0) {
    await corrBtns.first().click();
    await sleep(900);
    const traceRows = await page.locator('.modal-overlay table tbody tr, [class*=modal] table tbody tr').count();
    if (traceRows > 0) ok(`correlation trace modal (${traceRows} rows)`); else bug('correlation trace empty');
    await page.keyboard.press('Escape');
  } else bug('no correlation buttons');

  if (netErrors.length) { console.log('  NET/CONSOLE ERRORS:'); netErrors.forEach((e) => console.log('   ', e)); }
} catch (e) {
  bug('threw: ' + (e.message || e).toString().split('\n')[0]);
} finally {
  await browser.close();
  console.log(`\nBUGS (${bugs.length}):`);
  bugs.forEach((b) => console.log(' -', b));
  process.exit(bugs.length ? 1 : 0);
}
