import { chromium } from 'playwright';
const R = '/Users/brian/Documents/projects/IKG/datas';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 900, height: 1000 } })).newPage();
const apiCalls = [];
p.on('request', (r) => { if (r.url().includes('/browse/validate')) apiCalls.push(decodeURIComponent(r.url().split('path=')[1] || '')); });

await p.goto('http://localhost:8080/', { waitUntil: 'networkidle' });
await p.locator('input[autocomplete="username"]').fill('admin');
await p.locator('input[autocomplete="current-password"]').fill('admin');
await p.getByRole('button', { name: 'Sign in', exact: true }).click();
await p.waitForTimeout(1600);
await p.getByRole('button', { name: 'Admin', exact: true }).click();
await p.waitForTimeout(600);
await p.getByRole('button', { name: 'Dataset Types', exact: true }).click();
await p.waitForTimeout(600);
await p.getByRole('button', { name: 'New Root Type', exact: true }).click();
await p.waitForTimeout(600);

const modal = p.locator('.modal-card');
const field = (label) => modal.locator('.field').filter({ has: p.locator('span', { hasText: label }) }).first();
async function type(label, v) {
  const f = field(label);
  await f.locator('input').first().fill(v);
  await f.locator('input').first().blur();
  await p.waitForTimeout(700);
  const cls = await f.locator('input').first().getAttribute('class');
  const hint = (await f.locator('.hint').first().innerText().catch(() => '')).trim();
  return { border: cls || 'none', hint };
}
const submitEnabled = async () => !(await modal.getByRole('button', { name: /Create|Creating/ }).isDisabled());

await field('Name').locator('input').fill('Path Check');
await field('Code').locator('input').fill('PATH_CHECK');

console.log('--- format errors (must NOT hit the API) ---');
const nCallsBefore = apiCalls.length;
for (const v of ['relative/path', '/data/../etc', '/data\\win', ' /data/x ']) {
  console.log(' ', JSON.stringify(v), '->', JSON.stringify(await type('Dataset path (required)', v)));
}
console.log('  API calls made during the above:', apiCalls.length - nCallsBefore, '(expect 0)');

console.log('\n--- filesystem states (DO hit the API) ---');
for (const v of [`${R}/nope`, `${R}/datasets/dice/check/sb02_260523/classes.txt`, '/etc', `${R}/datasets/dice`]) {
  console.log(' ', v, '->', JSON.stringify(await type('Dataset path (required)', v)));
}

console.log('\n--- collision: model path same as dataset path ---');
console.log('  model ->', JSON.stringify(await type('Model path (required)', `${R}/datasets/dice`)));
console.log('  submit enabled?', await submitEnabled(), '(expect false)');

console.log('\n--- resolve the collision ---');
console.log('  model ->', JSON.stringify(await type('Model path (required)', `${R}/models`)));
console.log('  submit enabled?', await submitEnabled(), '(expect true)');

console.log('\n--- optional field: blank is fine, but a bad value is not ---');
console.log('  training ->', JSON.stringify(await type('Training dataset path (optional)', `${R}/nope2`)));
console.log('  submit enabled?', await submitEnabled(), '(expect false)');
await type('Training dataset path (optional)', '');
console.log('  after clearing, submit enabled?', await submitEnabled(), '(expect true)');

await p.screenshot({ path: '/tmp/pathfield.png' });
await b.close();
