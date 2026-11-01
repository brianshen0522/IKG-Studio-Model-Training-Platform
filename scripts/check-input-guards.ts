/**
 * Self-check for the request guards that have no running service behind them.
 * Run: npx tsx --tsconfig apps/api/tsconfig.json scripts/check-input-guards.ts
 */
import assert from 'node:assert/strict';
import { validateYoloArgs } from '../packages/shared-types/src/yolo-args';
import { isDatasetSubPath } from '../apps/api/src/common/roots';
import { CsrfService } from '../apps/api/src/auth/csrf.service';

const rejected = (args: Record<string, unknown>) => validateYoloArgs(args).map((i) => i.key);

// Arguments that would load something from a job-chosen path or URL.
assert.deepEqual(rejected({ cfg: 'x.yaml' }), ['cfg']);
assert.deepEqual(rejected({ distill_model: 'x.pt' }), ['distill_model']);
assert.deepEqual(rejected({ pretrained: 'x.pt' }), ['pretrained']);
assert.deepEqual(rejected({ pretrained: true, epochs: 3 }), []);
assert.deepEqual(rejected({ pretrained: false }), []);

// Dataset layout paths stay inside the dataset directory.
const dir = '/data/source/ds1';
for (const ok of ['images', 'a/b', 'classes.txt', `${dir}/classes.txt`, `${dir}/images`]) {
  assert.equal(isDatasetSubPath(dir, ok), true, ok);
}
for (const bad of ['', '/etc/passwd', '/proc/self/environ', '../x', 'a/../../x', `${dir}/../other`, `${dir}-2/x`, 'a\0b']) {
  assert.equal(isDatasetSubPath(dir, bad), false, bad);
}

// CSRF tokens depend on the configured secret, and there is no built-in one.
const service = (env: Record<string, string>) => new CsrfService(env as never);
const signed = service({ SESSION_SECRET: 'one' });
const token = signed.generateToken('session-a');
assert.equal(signed.validateToken(token, 'session-a'), true);
assert.equal(signed.validateToken(token, 'session-b'), false);
assert.equal(service({ SESSION_SECRET: 'two' }).validateToken(token, 'session-a'), false);
assert.equal(service({ CSRF_SECRET: 'one' }).validateToken(token, 'session-a'), true);
assert.equal(service({}).validateToken(token, 'session-a'), false);
assert.equal(signed.validateToken(`${token.split('.')[0]}.${'0'.repeat(64)}`, 'session-a'), false);
assert.equal(signed.validateToken('nonsense', 'session-a'), false);

console.log('input guards ok');
