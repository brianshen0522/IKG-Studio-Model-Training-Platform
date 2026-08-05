// Cross-engine auth/session/render check. Runs the login + session-persistence + all-pages
// flow in Chromium, Firefox AND WebKit (Safari engine). WebKit/Firefox do NOT grant the
// localhost "Secure cookie over http" leniency that Chromium does, so this catches
// Secure-cookie-over-HTTP and other engine-specific session bugs that a Chromium-only run misses.
import { chromium, firefox, webkit } from 'playwright';

const BASE = process.env.QA_URL || 'http://localhost:8088';
const PAGES = ['Home', 'Source Datasets', 'Models', 'Datasets', 'Training', 'Benchmarks', 'Admin'];
const engines = { chromium, firefox, webkit };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let totalFail = 0;

for (const [name, engine] of Object.entries(engines)) {
  console.log(`\n========== ${name.toUpperCase()} ==========`);
  const fails = [];
  const consoleErrors = [];
  const netErrors = [];
  let loggedIn = false;
  const fail = (m) => { fails.push(m); console.log('  ✗', m); };
  const ok = (m) => console.log('  ✓', m);

  const browser = await engine.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('response', (r) => {
    const s = r.status();
    // /auth/me 401 is expected only before login; flag it if it happens after login.
    if (s >= 400 && r.url().includes('/api/')) {
      if (r.url().endsWith('/auth/me') && !loggedIn) return;
      netErrors.push(`${s} ${r.request().method()} ${r.url().replace(BASE, '')}`);
    }
  });

  try {
    // 1) load + login
    await page.goto(BASE, { waitUntil: 'networkidle' });
    if (!(await page.locator('input[autocomplete="username"]').count())) fail('login form not shown');
    await page.locator('input[autocomplete="username"]').fill('admin');
    await page.locator('input[autocomplete="current-password"]').fill('AdminPass123!');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await sleep(1500);
    loggedIn = true;

    // 2) must go straight to dashboard (no forced change-password)
    if (await page.getByText('Set a new password').count()) fail('forced change-password screen appeared');
    if (await page.getByRole('heading', { name: 'Dashboard' }).count()) ok('dashboard shown after login');
    else fail('dashboard NOT shown after login (login/session failed)');

    // 3) the session cookie must actually be STORED by the browser + correct attributes
    const cookies = await ctx.cookies();
    const sid = cookies.find((c) => c.name === 'sid');
    if (!sid) fail('session cookie "sid" was NOT stored by the browser (Secure-over-HTTP or SameSite issue)');
    else {
      ok('session cookie stored');
      if (sid.secure) fail('session cookie has Secure=true over HTTP (will be dropped by browsers)');
      else ok('session cookie Secure=false (correct for HTTP)');
      if (!sid.httpOnly) fail('session cookie is not HttpOnly');
    }

    // 4) THE key regression test: reload → app re-bootstraps via /auth/me using the stored cookie.
    //    If the cookie wasn't sent, /auth/me 401s and the user is bounced to login / "Session expired".
    let meAfterReload = null;
    const meListener = (r) => { if (r.url().endsWith('/auth/me')) meAfterReload = r.status(); };
    page.on('response', meListener);
    await page.reload({ waitUntil: 'networkidle' });
    await sleep(1200);
    page.off('response', meListener);
    if (meAfterReload === 200) ok('/auth/me = 200 after reload (session persists)');
    else fail(`/auth/me = ${meAfterReload} after reload (session did NOT persist)`);
    if (await page.getByText(/session expired/i).count()) fail('"Session expired" shown after reload');
    if (await page.locator('input[autocomplete="username"]').count()) fail('bounced back to LOGIN after reload (session lost)');
    else ok('still authenticated after reload');

    // 5) every page renders (heading present) without new console/network errors
    for (const nav of PAGES) {
      const before = consoleErrors.length + netErrors.length;
      const btn = page.getByRole('button', { name: nav, exact: true });
      if (!(await btn.count())) { fail('nav missing: ' + nav); continue; }
      await btn.click(); await sleep(600);
      const after = consoleErrors.length + netErrors.length;
      if (after > before) fail(`errors while on "${nav}"`);
    }
    ok('navigated all ' + PAGES.length + ' pages');

    // 6) logout returns to login
    await page.getByRole('button', { name: 'Logout', exact: true }).click(); await sleep(1000);
    if (await page.locator('input[autocomplete="username"]').count()) ok('logout → login screen');
    else fail('logout did not return to login');
  } catch (e) {
    fail('threw: ' + (e.message || e).toString().split('\n')[0]);
  }

  await browser.close();
  if (consoleErrors.length) { console.log('  console errors:'); [...new Set(consoleErrors)].forEach((e) => console.log('    - ' + e)); }
  if (netErrors.length) { console.log('  network errors:'); [...new Set(netErrors)].forEach((e) => console.log('    - ' + e)); }
  console.log(`  RESULT: ${fails.length === 0 ? 'PASS' : 'FAIL (' + fails.length + ')'}`);
  totalFail += fails.length;
}

console.log(`\n================ TOTAL FAILURES: ${totalFail} ================`);
process.exit(totalFail === 0 ? 0 : 1);
