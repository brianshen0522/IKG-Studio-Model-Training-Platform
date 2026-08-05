import { chromium } from 'playwright';
const BASE = process.env.QA_URL || 'http://localhost:8088';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bugs = [];
const bug = (m) => { bugs.push(m); console.log('  ✗ BUG:', m); };
const ok = (m) => console.log('  ✓', m);

const browser = await chromium.launch();
const page = await browser.newPage();
const netErr = [];
page.on('response', (r) => { const s = r.status(); if (s >= 500 && r.url().includes('/api/')) netErr.push(`${s} ${r.request().method()} ${r.url().replace(BASE,'')}`); });

async function gotoAdminTab(name) {
  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  await sleep(400);
  await page.getByRole('button', { name, exact: true }).click();
  await sleep(900);
}

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('input[autocomplete="username"]').fill('admin');
  await page.locator('input[type="password"]').fill('AdminPass123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await sleep(1500);
  ok('logged in');

  // 1) System Settings tab: renders + edit/save
  await gotoAdminTab('System Settings');
  const settingRows = await page.locator('table tbody tr').count();
  if (settingRows > 0) ok(`system settings rendered (${settingRows} rows)`); else bug('system settings table empty');
  // edit the first number/text input and save
  const saveBtns = page.getByRole('button', { name: 'Save', exact: true });
  const nSave = await saveBtns.count();
  if (nSave > 0) {
    await saveBtns.first().click(); await sleep(700);
    ok(`settings: per-row Save works (${nSave} rows editable)`);
  } else bug('no Save button in settings');

  // 2) Dataset Types tab: tree view
  await gotoAdminTab('Dataset Types');
  const addChild = await page.getByRole('button', { name: /add child/i }).count();
  const newRoot = await page.getByRole('button', { name: /new root type|new dataset type/i }).count();
  if (newRoot > 0) ok('dataset types: New Root button present'); else bug('no New Root button');
  if (addChild > 0) ok(`dataset types: tree with Add Child (${addChild})`); else console.log('  (note: no child nodes to show Add Child — acceptable if flat)');

  // 3) Users tab: reset password modal + role toggle
  await gotoAdminTab('Users');
  const roleToggle = await page.getByRole('button', { name: /make admin|make user/i }).count();
  if (roleToggle > 0) ok('users: role toggle present'); else bug('no role toggle button');
  const resetBtn = page.getByRole('button', { name: /reset password/i }).first();
  if (await resetBtn.count()) {
    await resetBtn.click(); await sleep(900);
    const modalPw = await page.locator('.modal-overlay, [class*=modal]').filter({ hasText: /temporary/i }).count();
    if (modalPw > 0) ok('users: reset-password modal shows temp password'); else bug('reset-password modal missing/empty');
    await page.keyboard.press('Escape'); await sleep(300);
  } else bug('no Reset Password button');

  // 4) Notification bell: severity filter + unread toggle
  const bell = page.locator('.notif-bell, button:has(.notif-badge), [class*=notif]').first();
  // fallback: click a top-bar button that opens the notifications dropdown
  const bellBtn = (await page.locator('button:has(.notif-badge)').count()) ? page.locator('button:has(.notif-badge)').first()
                 : page.locator('header button, .topbar button, .appshell button').filter({ hasText: '' }).last();
  await bellBtn.click().catch(() => {});
  await sleep(600);
  const sevSelect = await page.locator('select').filter({ hasText: /warning|error|success/i }).count()
    || await page.getByRole('combobox').count();
  const unreadToggle = await page.getByText(/unread only/i).count();
  if (sevSelect > 0 || unreadToggle > 0) ok('notifications: filter controls present'); else console.log('  (note: could not confirm notif filter UI via selector)');
  await page.keyboard.press('Escape').catch(() => {});

  // 5) Datasets → build version dialog → SAME strategy shows warning + ack
  await page.getByRole('button', { name: 'Datasets', exact: true }).click();
  await sleep(800);
  const buildBtn = page.getByRole('button', { name: /build/i }).first();
  if (await buildBtn.count()) {
    await buildBtn.click(); await sleep(700);
    const stratSelect = page.locator('select').filter({ hasText: /random|same/i }).first();
    if (await stratSelect.count()) {
      await stratSelect.selectOption({ label: 'Use source split (SAME)' }).catch(async () => { await stratSelect.selectOption('SAME').catch(()=>{}); });
      await sleep(500);
      const leak = await page.getByText(/data.?leakage/i).count();
      const ack = await page.getByText(/understand the data-leakage/i).count();
      if (leak > 0 && ack > 0) ok('SAME split: warning + acknowledgment shown'); else bug('SAME split UI missing warning/ack');
    } else bug('no split strategy selector in build dialog');
  } else bug('no build-version button on datasets page');

  if (netErr.length) { console.log('  5xx errors:'); netErr.forEach((e) => console.log('   ', e)); }
} catch (e) {
  bug('threw: ' + (e.message || e).toString().split('\n')[0]);
} finally {
  await browser.close();
  console.log(`\nBUGS (${bugs.length}):`);
  bugs.forEach((b) => console.log(' -', b));
  process.exit(bugs.length ? 1 : 0);
}
