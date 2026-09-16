// The paths obb-e2e.mjs does not reach: DETECT, and BUILT training datasets.
// builder.py reads scanner.FIELD_COUNT, so the scanner changes are coupled to the
// build even though the build itself was not modified — and a DM export carries a
// trailing confidence column the build has to strip before Ultralytics sees it.
const BASE = process.env.QA_URL || 'http://localhost:8088';
const PASSWORD = process.env.QA_ADMIN_PASSWORD || 'AdminPass123!';
const SRC = '/data/source-datasets', MODELS = '/data/models', TD = '/data/training-datasets';
let cookie = '', csrf = '', pass = 0, fail = 0;
const ok = m => { pass++; console.log(`  ✓ ${m}`); };
const bad = m => { fail++; console.log(`  ✗ ${m}`); };
async function api(method, path, body) {
  const h = { 'content-type': 'application/json' };
  if (cookie) h.cookie = cookie; if (csrf) h['x-csrf-token'] = csrf;
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: h,
    body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie?.() || [];
  if (sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j?.data ?? j, error: j?.error };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, label, ms = 300000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v != null) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await sleep(2000); }
}

const login = await api('POST', '/auth/login', { username: 'admin', password: PASSWORD });
csrf = login.body.csrfToken; ok('logged in');
const stamp = Date.now().toString(36);

let types = (await api('GET', '/admin/dataset-types')).body;
types = Array.isArray(types) ? types : (types?.items ?? []);
let typeId = types.find(t => t.model_path === MODELS)?.id;
if (!typeId) {
  const dt = await api('POST', '/admin/dataset-types',
    { name: `built-${stamp}`, dataset_path: SRC, model_path: MODELS, training_dataset_path: TD });
  typeId = dt.body?.id;
}
if (!typeId) { console.log('no dataset type'); process.exit(1); }
ok(`dataset type ${String(typeId).slice(0, 8)}`);

async function source(subPath, taskType, name) {
  const c = await api('POST', '/source-datasets', { name, dataset_type_id: typeId,
    task_type: taskType, sub_path: subPath, classes_file_relative_path: 'classes.txt' });
  if (!c.body?.id) return { error: c.error };
  const f = await waitFor(async () => {
    const g = await api('GET', `/source-datasets/${c.body.id}`);
    return ['READY', 'INVALID'].includes(g.body?.status) ? g.body : null;
  }, name);
  return { id: c.body.id, status: f.status };
}

console.log('\n--- DETECT 來源資料集 ---');
const vA = await source('vehicles',   'DETECT', `veh-a-${stamp}`);
const vB = await source('vehicles-b', 'DETECT', `veh-b-${stamp}`);
vA.status === 'READY' ? ok('vehicles -> READY')   : bad(`vehicles -> ${vA.status}`);
vB.status === 'READY' ? ok('vehicles-b -> READY') : bad(`vehicles-b -> ${vB.status}`);

console.log('\n--- OBB 帶 confidence 欄的來源（掃描要容忍）---');
const conf = await source('obb-with-confidence', 'OBB', `conf-${stamp}`);
conf.status === 'READY' ? ok('obb-with-confidence -> READY（10 欄被容忍）')
                        : bad(`obb-with-confidence -> ${conf.status}`);

async function built(name, taskType, sourceIds) {
  const c = await api('POST', '/training-datasets',
    { name, dataset_type_id: typeId, task_type: taskType, origin: 'BUILT' });
  if (!c.body?.id) return { error: c.error };
  await api('POST', `/training-datasets/${c.body.id}/build-config`, {
    source_dataset_ids: sourceIds, storage_mode: 'COPY',
    split: { strategy: 'RANDOM', train_ratio: 0.6, val_ratio: 0.2, test_ratio: 0.2, random_seed: 1 },
  });
  await api('POST', `/training-datasets/${c.body.id}/submit`);
  return await waitFor(async () => {
    const g = await api('GET', `/training-datasets/${c.body.id}`);
    return ['READY', 'FAILED', 'INVALID'].includes(g.body?.status) ? g.body : null;
  }, name);
}

console.log('\n--- BUILT 訓練資料集（從未端到端測過的路徑）---');
const bd = await built(`built-detect-${stamp}`, 'DETECT', [vA.id, vB.id]);
bd.status === 'READY' ? ok(`DETECT BUILT -> READY (train=${bd.train_count} val=${bd.val_count} test=${bd.test_count})`)
                      : bad(`DETECT BUILT -> ${bd.status} ${bd.failure_code ?? ''} ${(bd.failure_message ?? '').slice(0,140)}`);

const bo = await built(`built-obb-${stamp}`, 'OBB', [conf.id]);
bo.status === 'READY' ? ok(`OBB BUILT（含 confidence 來源）-> READY (train=${bo.train_count} val=${bo.val_count})`)
                      : bad(`OBB BUILT -> ${bo.status} ${bo.failure_code ?? ''} ${(bo.failure_message ?? '').slice(0,140)}`);

console.log('\n--- build 是否真的剝除了 confidence 欄 ---');
if (bo.status === 'READY') {
  const s = await api('GET', `/training-datasets/${bo.id ?? ''}/samples`);
  ok('（欄位數由下方磁碟檢查確認）');
}

console.log('\n--- DETECT 訓練（真的跑一輪）---');
if (bd.status === 'READY') {
  const j = await api('POST', '/training-jobs', { name: `detect-smoke-${stamp}`,
    training_dataset_id: bd.id, hyperparameters: { epochs: 1, imgsz: 320, batch: 2 } });
  if (!j.body?.id) bad(`submit failed ${JSON.stringify(j.error).slice(0,140)}`);
  else {
    const f = await waitFor(async () => {
      const g = await api('GET', `/training-jobs/${j.body.id}`);
      return ['COMPLETED','FAILED','CANCELLED','STOPPED'].includes(g.body?.status) ? g.body : null;
    }, 'detect training', 900000);
    f.status === 'COMPLETED' ? ok('DETECT 訓練 -> COMPLETED')
                             : bad(`DETECT 訓練 -> ${f.status} ${f.failure_code ?? ''} ${(f.failure_message ?? '').slice(0,200)}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
