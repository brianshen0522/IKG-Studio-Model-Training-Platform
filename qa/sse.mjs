import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
const BASE = process.env.QA_URL || 'http://localhost:8088';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bugs = [];
const bug = (m) => { bugs.push(m); console.log('  ✗ BUG:', m); };
const ok = (m) => console.log('  ✓', m);
const psql = (sql) => execSync(`docker compose -f deploy/docker-compose.qa.yml exec -T postgres psql -U migration_role -d model_trainer -Atc "${sql}"`, { cwd: '/Users/brian/Documents/projects/IKG-Studio-YOLO-Training-Platform' }).toString().trim();

const browser = await chromium.launch();
const page = await browser.newPage();
let streamOpened = false;
page.on('request', (r) => { if (r.url().includes('/events/stream')) streamOpened = true; });
const consoleErr = [];
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('/auth/me')) consoleErr.push(m.text()); });

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('input[autocomplete="username"]').fill('admin');
  await page.locator('input[type="password"]').fill('AdminPass123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await sleep(2000);
  ok('logged in');

  if (streamOpened) ok('EventSource opened /events/stream'); else bug('no EventSource connection to /events/stream');

  // read current unread badge (may be empty)
  const badgeBefore = (await page.locator('.notif-badge').count()) ? (await page.locator('.notif-badge').first().innerText()).trim() : '0';

  // inject a notification for admin via DB trigger → SSE should push → bell refetches
  const aid = psql("SELECT id FROM app.users WHERE username='admin'");
  const alid = psql('SELECT id FROM app.audit_logs ORDER BY id DESC LIMIT 1');
  psql(`INSERT INTO app.notifications (audit_log_id, recipient_user_id, severity, title, message, resource_type_code, resource_id) VALUES (${alid}, '${aid}', 'WARNING', 'SSE Browser Test', 'pushed via SSE', 'TRAINING_JOB', gen_random_uuid())`);
  console.log('  injected a notification');

  // wait for SSE-driven refetch (should be fast; poll the badge up to ~4s)
  let updated = false;
  for (let i = 0; i < 8; i++) {
    await sleep(500);
    const cnt = (await page.locator('.notif-badge').count()) ? (await page.locator('.notif-badge').first().innerText()).trim() : '0';
    if (cnt !== badgeBefore) { ok(`bell unread updated via SSE: ${badgeBefore} → ${cnt}`); updated = true; break; }
  }
  if (!updated) bug(`bell badge did not update after SSE push (still ${badgeBefore})`);

  if (consoleErr.length) { console.log('  console errors:'); consoleErr.forEach((e) => console.log('   ', e)); }
} catch (e) {
  bug('threw: ' + (e.message || e).toString().split('\n')[0]);
} finally {
  await browser.close();
  console.log(`\nBUGS (${bugs.length}):`);
  bugs.forEach((b) => console.log(' -', b));
  process.exit(bugs.length ? 1 : 0);
}
