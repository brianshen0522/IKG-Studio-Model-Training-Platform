import { chromium } from 'playwright';
const BASE = process.env.QA_URL || 'http://localhost:8088';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bugs = [];
const bug = (m) => { bugs.push(m); console.log('  ✗ BUG:', m); };
const ok = (m) => console.log('  ✓', m);
const browser = await chromium.launch();
const page = await browser.newPage();
try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('input[autocomplete="username"]').fill('admin');
  await page.locator('input[type="password"]').fill('AdminPass123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await sleep(1800); ok('logged in');

  // Dashboard system health
  const healthText = await page.locator('body').innerText();
  if (/system health/i.test(healthText) || /pending outbox|active executions|workers/i.test(healthText)) ok('dashboard shows system health'); else bug('no system health on dashboard');

  // Admin → Workers tab
  await page.getByRole('button', { name: 'Admin', exact: true }).click(); await sleep(400);
  await page.getByRole('button', { name: 'Workers', exact: true }).click(); await sleep(900);
  const wrows = await page.locator('table tbody tr').count();
  if (wrows >= 2) ok(`workers tab: ${wrows} workers`); else bug(`workers tab rows=${wrows} (expected >=2)`);
  const hasTraining = (await page.locator('table tbody tr', { hasText: 'training-worker' }).count()) > 0;
  if (hasTraining) ok('training-worker listed'); else bug('training-worker not in workers table');

  // Training → open a job → Clone button
  await page.getByRole('button', { name: 'Training', exact: true }).click(); await sleep(1000);
  const jobRows = page.locator('table tbody tr');
  if (await jobRows.count() > 0) {
    await jobRows.first().click(); await sleep(1000);
    const cloneBtn = page.getByRole('button', { name: 'Clone', exact: true });
    if (await cloneBtn.count()) ok('training detail: Clone button present'); else bug('no Clone button on training detail');
  } else bug('no training jobs to open');

  // New training dialog → dependency checklist
  await page.getByRole('button', { name: 'Training', exact: true }).click(); await sleep(600);
  const newBtn = page.getByRole('button', { name: /new training|new job|create training/i }).first();
  if (await newBtn.count()) {
    await newBtn.click(); await sleep(700);
    const bodyTxt = await page.locator('.modal-overlay, [class*=modal]').innerText().catch(() => '');
    if (/depend/i.test(bodyTxt)) ok('new-training dialog has dependency selector'); else console.log('  (note: dependency selector label not detected in dialog)');
    await page.keyboard.press('Escape');
  } else console.log('  (note: could not find New Training button)');
} catch (e) { bug('threw: ' + (e.message || e).toString().split('\n')[0]); }
finally {
  await browser.close();
  console.log(`\nBUGS (${bugs.length}):`); bugs.forEach((b) => console.log(' -', b));
  process.exit(bugs.length ? 1 : 0);
}
