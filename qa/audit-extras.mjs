import { chromium } from 'playwright';
const BASE = process.env.QA_URL || 'http://localhost:8088';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bugs = [];
const bug = (m) => { bugs.push(m); console.log('  ✗ BUG:', m); };
const ok = (m) => console.log('  ✓', m);

const browser = await chromium.launch();
const page = await browser.newPage({ acceptDownloads: true });
try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('input[autocomplete="username"]').fill('admin');
  await page.locator('input[type="password"]').fill('AdminPass123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await sleep(1500);
  ok('logged in');

  // --- Audit tab: Export CSV triggers a download ---
  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  await sleep(500);
  await page.getByRole('button', { name: 'Audit', exact: true }).click();
  await sleep(1000);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
    page.getByRole('button', { name: 'Export CSV', exact: true }).click(),
  ]);
  if (download) {
    const fn = download.suggestedFilename();
    ok(`export downloaded (${fn})`);
    if (!/audit-export.*\.csv/.test(fn)) bug(`unexpected filename: ${fn}`);
  } else bug('Export CSV did not trigger a download');

  // --- Training job detail: History panel ---
  await page.getByRole('button', { name: 'Training', exact: true }).click();
  await sleep(1200);
  const rows = page.locator('table tbody tr');
  if (await rows.count() === 0) { bug('no training jobs to open'); }
  else {
    await rows.first().click();
    await sleep(1200);
    const hasHistoryHead = await page.locator('h3', { hasText: 'History' }).count();
    if (!hasHistoryHead) bug('History heading not found on job detail');
    else {
      // the History table is the last table on the page
      const tables = page.locator('.table-wrap table');
      const n = await tables.count();
      const histRows = await tables.nth(n - 1).locator('tbody tr').count();
      if (histRows > 0) ok(`History panel rendered (${histRows} rows)`); else bug('History panel empty');
    }
  }
} catch (e) {
  bug('threw: ' + (e.message || e).toString().split('\n')[0]);
} finally {
  await browser.close();
  console.log(`\nBUGS (${bugs.length}):`);
  bugs.forEach((b) => console.log(' -', b));
  process.exit(bugs.length ? 1 : 0);
}
