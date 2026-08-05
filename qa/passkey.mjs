// Passkey (WebAuthn) end-to-end via Chromium's virtual authenticator (CDP).
// Registers a passkey, signs out, signs back in passwordlessly, then revokes it.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.QA_URL || 'http://localhost:8088';
const SHOTS = new URL('./shots/passkey/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bugs = [];
const bug = (m) => { bugs.push(m); console.log('  ✗', m); };
const ok = (m) => console.log('  ✓', m);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const net = [];
page.on('response', (r) => { const s = r.status(); if (s >= 400 && r.url().includes('/api/') && !r.url().endsWith('/auth/me')) net.push(`${s} ${r.request().method()} ${r.url().replace(BASE, '')}`); });

// Attach a virtual authenticator (platform, resident-key, user-verified) so ceremonies auto-succeed.
const cdp = await ctx.newCDPSession(page);
await cdp.send('WebAuthn.enable', { enableUI: false });
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});

const shot = (n) => page.screenshot({ path: SHOTS + n + '.png', fullPage: true }).catch(() => {});
const clickBtn = (n) => page.getByRole('button', { name: n, exact: true }).click();

try {
  // 1) password login
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('input[autocomplete="username"]').fill('admin');
  await page.locator('input[autocomplete="current-password"]').fill('AdminPass123!');
  await clickBtn('Sign in'); await sleep(1500);
  if (await page.getByRole('heading', { name: 'Dashboard' }).count()) ok('password login'); else bug('password login failed');

  // 2) go to Account & Security → add passkey
  await page.locator('.user-btn').click(); await sleep(600);
  if (await page.getByRole('heading', { name: 'Account & Security' }).count()) ok('account page opens'); else bug('account page missing');
  await clickBtn('Add passkey'); await sleep(400);
  await page.locator('.modal-card label.field input').first().fill('QA Virtual Key');
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await sleep(2500);
  await shot('after-register');
  const cred = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  if (cred.credentials.length === 1) ok('virtual credential created'); else bug('expected 1 credential, got ' + cred.credentials.length);
  if (await page.getByText('QA Virtual Key').count()) ok('passkey listed in account'); else bug('passkey not listed');

  // 3) logout
  await clickBtn('Logout'); await sleep(1000);
  if (await page.locator('input[autocomplete="username"]').count()) ok('logged out'); else bug('logout failed');

  // 4) passwordless login with the passkey
  if (await page.getByRole('button', { name: '🔑 Sign in with a passkey', exact: true }).count()) ok('passkey button shown on login'); else bug('no passkey button on login');
  await page.getByRole('button', { name: '🔑 Sign in with a passkey', exact: true }).click();
  await sleep(2500);
  await shot('after-passkey-login');
  // Authenticated = no longer on the login form + the app shell (nav) is present.
  const onLogin = await page.locator('input[autocomplete="username"]').count();
  const authed = await page.getByRole('button', { name: 'Home', exact: true }).count();
  if (!onLogin && authed) ok('PASSWORDLESS passkey login → authenticated'); else bug('passkey login did NOT authenticate');
  // and the dashboard is reachable
  if (authed) { await page.getByRole('button', { name: 'Home', exact: true }).click(); await sleep(500); }
  if (await page.getByRole('heading', { name: 'Dashboard' }).count()) ok('dashboard reachable after passkey login');

  // 5) revoke the passkey
  await page.locator('.user-btn').click(); await sleep(600);
  await page.locator('tr', { hasText: 'QA Virtual Key' }).getByRole('button', { name: 'Remove' }).click();
  await sleep(1200);
  if (!(await page.getByText('QA Virtual Key').count())) ok('passkey revoked (removed from list)'); else bug('passkey still listed after remove');

  // 6) after revoke, passwordless login must fail
  await clickBtn('Logout'); await sleep(1000);
  await page.getByRole('button', { name: '🔑 Sign in with a passkey', exact: true }).click();
  await sleep(2500);
  if (await page.locator('input[autocomplete="username"]').count() && !(await page.getByRole('heading', { name: 'Dashboard' }).count())) ok('passkey login correctly fails after revoke'); else bug('passkey login still worked after revoke');
} catch (e) {
  bug('threw: ' + (e.message || e).toString().split('\n')[0]);
}

await browser.close();
console.log('\n==================== PASSKEY QA ====================');
console.log('BUGS (' + bugs.length + '):'); bugs.forEach((b) => console.log('  - ' + b));
console.log('NET 4xx/5xx (' + [...new Set(net)].length + '):'); [...new Set(net)].forEach((e) => console.log('  - ' + e));
console.log('===================================================');
process.exit(bugs.length === 0 ? 0 : 1);
