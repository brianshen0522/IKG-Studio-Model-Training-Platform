import { chromium } from 'playwright';

const BASE = 'https://192.168.20.10';
const PASSWORD = process.env.QA_PASSWORD || 'admin';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, ignoreHTTPSErrors: true, acceptDownloads: true });
const page = await ctx.newPage();
page.on('console', (m) => console.log('CONSOLE', m.type(), m.text()));
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.locator('input[autocomplete="username"]').fill('admin');
await page.locator('input[autocomplete="current-password"]').fill(PASSWORD);
await page.getByRole('button', { name: 'Sign in', exact: true }).click();
await page.waitForTimeout(1500);

const nav = async (n) => {
  const exact = page.getByRole('button', { name: n, exact: true });
  if (await exact.count()) await exact.first().click();
  else await page.getByRole('button', { name: new RegExp('^' + n) }).first().click();
  await page.waitForTimeout(600);
};

await nav('Benchmarks');
await page.waitForTimeout(1000);
await page.getByRole('button', { name: 'Compare Models', exact: true }).click();
await page.waitForTimeout(800);

const modal = () => page.locator('.modal-card');
const dtSelect = modal().locator('select').first();
await dtSelect.selectOption({ label: 'cards' });
await page.waitForTimeout(400);
await modal().getByRole('button', { name: /^Next$/i }).click();
await page.waitForTimeout(1000);

const checkboxes = modal().locator('input[type="checkbox"]:not([disabled])');
await checkboxes.nth(0).check();
await checkboxes.nth(1).check();
await page.waitForTimeout(300);
await modal().getByRole('button', { name: /^Compare$/i }).click();
await page.waitForTimeout(1500);

await modal().getByRole('button', { name: /PNG/ }).click();
await page.waitForTimeout(3000);

await browser.close();
