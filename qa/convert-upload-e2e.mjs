// The paths the other suites do not reach: an OpenVINO conversion, a model uploaded
// as multipart rather than fetched from a URL, and a registered dataset in DETECT.
// None of these were ever run — they were only read.
const BASE = process.env.QA_URL || 'http://localhost:8088';
const PASSWORD = process.env.QA_ADMIN_PASSWORD || 'AdminPass123!';
const SRC = '/data/source-datasets', MODELS = '/data/models', TD = '/data/training-datasets';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cookie = '', csrf = '', pass = 0, fail = 0;
const ok = m => { pass++; console.log(`  ✓ ${m}`); };
const bad = m => { fail++; console.log(`  ✗ ${m}`); };
async function api(method, path, body, extraHeaders) {
  const h = { ...(extraHeaders || {}) };
  if (!(body instanceof FormData)) h['content-type'] = 'application/json';
  if (cookie) h.cookie = cookie; if (csrf) h['x-csrf-token'] = csrf;
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: h,
    body: body === undefined ? undefined : (body instanceof FormData ? body : JSON.stringify(body)) });
  const sc = r.headers.getSetCookie?.() || [];
  if (sc.length) cookie = sc.map(c => c.split(';')[0]).join('; ');
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j?.data ?? j, error: j?.error };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, label, ms = 600000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v != null) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await sleep(3000); }
}

const login = await api('POST', '/auth/login', { username: 'admin', password: PASSWORD });
csrf = login.body.csrfToken; ok('logged in');
const stamp = Date.now().toString(36);

let types = (await api('GET', '/admin/dataset-types')).body;
types = Array.isArray(types) ? types : (types?.items ?? []);
let typeId = types.find(t => t.model_path === MODELS)?.id;
if (!typeId) {
  typeId = (await api('POST', '/admin/dataset-types',
    { name: `conv-${stamp}`, dataset_path: SRC, model_path: MODELS, training_dataset_path: TD })).body?.id;
}
if (!typeId) { console.log('no dataset type'); process.exit(1); }

// ---------------------------------------------------------------- UPLOAD ingest
console.log('\n--- 模型以 multipart 上傳（先前只測過 URL_DOWNLOAD）---');
const here = dirname(fileURLToPath(import.meta.url));
const weights = readFileSync(join(here, '..', 'deploy', 'qa-assets', 'yolo11n-obb.pt'));

async function upload(name, taskType) {
  const fd = new FormData();
  fd.append('file', new Blob([weights]), 'yolo11n-obb.pt');
  fd.append('name', name);
  fd.append('dataset_type_id', typeId);
  fd.append('task_type', taskType);
  const c = await api('POST', '/models/ingest/upload', fd);
  const taskId = c.body?.id ?? c.body?.model_ingest_task_id;
  if (!taskId) return { create_error: c.error, status: c.status };
  return await waitFor(async () => {
    const g = await api('GET', `/models/ingest-tasks/${taskId}`);
    return ['COMPLETED', 'FAILED'].includes(g.body?.status) ? g.body : null;
  }, name);
}

const upMismatch = await upload(`up-bad-${stamp}`, 'DETECT');   // OBB weights, declared DETECT
upMismatch.status === 'FAILED' && upMismatch.failure_code === 'MODEL_TASK_TYPE_MISMATCH'
  ? ok(`上傳 OBB 權重卻宣告 DETECT -> ${upMismatch.failure_code}`)
  : bad(`-> ${upMismatch.status} ${upMismatch.failure_code ?? ''} ${JSON.stringify(upMismatch.create_error ?? '')}`);

const upOk = await upload(`up-ok-${stamp}`, 'OBB');
upOk.status === 'COMPLETED' ? ok('上傳 OBB 權重且宣告 OBB -> COMPLETED')
                            : bad(`-> ${upOk.status} ${(upOk.failure_message ?? '').slice(0, 140)}`);

// ------------------------------------------------------------ OpenVINO convert
console.log('\n--- OpenVINO 轉檔（從未實跑過）---');
let models = (await api('GET', `/models?dataset_type_id=${typeId}&status=AVAILABLE`)).body;
models = Array.isArray(models) ? models : (models?.items ?? []);
const obbModel = models.find(m => m.task_type === 'OBB');
if (!obbModel) bad('沒有可用的 OBB 模型可轉檔');
else {
  const c = await api('POST', `/models/${obbModel.id}/conversions`, { args: { imgsz: 320 } });
  const convId = c.body?.id;
  if (!convId) bad(`轉檔提交失敗 ${c.status} ${JSON.stringify(c.error).slice(0, 160)}`);
  else {
    const f = await waitFor(async () => {
      const g = await api('GET', `/models/${obbModel.id}/conversions/${convId}`);
      return ['SUCCEEDED', 'FAILED'].includes(g.body?.status) ? g.body : null;
    }, 'openvino conversion');
    f.status === 'SUCCEEDED' ? ok(`OBB 模型轉 OpenVINO -> SUCCEEDED`)
                             : bad(`-> ${f.status} ${f.failure_code ?? ''} ${(f.failure_message ?? '').slice(0, 200)}`);
  }
}

// ------------------------------------------------- REGISTERED + DETECT
console.log('\n--- REGISTERED 訓練資料集 + DETECT（先前只測過 OBB）---');
const c = await api('POST', '/training-datasets', { name: `reg-detect-${stamp}`,
  dataset_type_id: typeId, task_type: 'DETECT', origin: 'REGISTERED', relative_path: 'registered-detect' });
if (!c.body?.id) bad(`建立失敗 ${JSON.stringify(c.error).slice(0, 160)}`);
else {
  await api('POST', `/training-datasets/${c.body.id}/submit`);
  const f = await waitFor(async () => {
    const g = await api('GET', `/training-datasets/${c.body.id}`);
    return ['READY', 'FAILED', 'INVALID'].includes(g.body?.status) ? g.body : null;
  }, 'registered detect');
  f.status === 'READY' ? ok('registered-detect -> READY（無誤判）')
                       : bad(`-> ${f.status} ${f.failure_code ?? ''} ${(f.failure_message ?? '').slice(0, 160)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
