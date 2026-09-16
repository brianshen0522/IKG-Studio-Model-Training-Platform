// End-to-end check of the OBB defensive validation, against a running QA stack.
// Exercises the paths the unit tests could only call directly: a real scan job, a
// real registered-dataset validation and a real model ingest, each through the API.
const BASE = process.env.QA_URL || 'http://localhost:8088';
const PASSWORD = process.env.QA_ADMIN_PASSWORD || 'AdminPass123!';
const SRC = process.env.QA_SOURCE_PATH || '/data/source-datasets';
const MODELS = process.env.QA_MODEL_PATH || '/data/models';
const TD = process.env.QA_TD_PATH || '/data/training-datasets';

let cookie = '', csrf = '', pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m) => { fail++; console.log(`  ✗ ${m}`); };

async function api(method, path, body) {
  const h = { 'content-type': 'application/json' };
  if (cookie) h.cookie = cookie;
  if (csrf) h['x-csrf-token'] = csrf;
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.getSetCookie?.() || [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  let j = null;
  try { j = await r.json(); } catch { /* 204 and friends */ }
  return { status: r.status, body: j?.data ?? j, error: j?.error };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, timeoutMs = 120000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== null && v !== undefined) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(1500);
  }
}

async function main() {
  const login = await api('POST', '/auth/login', { username: 'admin', password: PASSWORD });
  if (login.status !== 200 && login.status !== 201) throw new Error(`login failed: ${login.status} ${JSON.stringify(login.error)}`);
  csrf = login.body.csrfToken;
  ok('logged in');

  const stamp = Date.now().toString(36);
  // Model roots may not overlap, and every suite here wants the same one — so a run
  // after any other on the same database cannot create its own type, it has to take
  // the one already holding /data/models.
  let types = (await api('GET', '/admin/dataset-types')).body;
  types = Array.isArray(types) ? types : (types?.items ?? []);
  let typeId = types.find((t) => t.model_path === MODELS)?.id;
  if (typeId) ok(`reusing dataset type (${typeId.slice(0, 8)})`);
  else {
    const dt = await api('POST', '/admin/dataset-types', {
      name: `obb-e2e-${stamp}`, dataset_path: SRC, model_path: MODELS, training_dataset_path: TD,
    });
    if (!dt.body?.id) throw new Error(`dataset type create failed: ${dt.status} ${JSON.stringify(dt.error)}`);
    typeId = dt.body.id;
    ok(`dataset type created (${typeId.slice(0, 8)})`);
  }

  // ---- source dataset scans -------------------------------------------------
  async function scanSource(subPath, name) {
    const c = await api('POST', '/source-datasets', {
      name, dataset_type_id: typeId, task_type: 'OBB', sub_path: subPath,
      classes_file_relative_path: 'classes.txt',
    });
    if (!c.body?.id) return { error: c.error, status: c.status };
    const id = c.body.id;
    const final = await waitFor(async () => {
      const g = await api('GET', `/source-datasets/${id}`);
      const s = g.body?.status;
      return (s === 'READY' || s === 'INVALID') ? g.body : null;
    }, `${name} scan`);
    const scans = await api('GET', `/source-datasets/${id}/scans`);
    const latest = (scans.body || [])[0];
    let issues = [];
    if (latest?.id) {
      const d = await api('GET', `/source-datasets/${id}/scans/${latest.id}/issues?severity=ERROR`);
      issues = Array.isArray(d.body) ? d.body : (d.body?.items || []);
    }
    return { status: final.status, issues };
  }

  console.log('\n--- 情境 1: 含退化 OBB 的來源資料集應被判定 INVALID ---');
  const deg = await scanSource('obb-degenerate', `deg-${stamp}`);
  if (deg.status === 'INVALID') ok('obb-degenerate -> INVALID');
  else bad(`obb-degenerate -> ${deg.status} (expected INVALID)`);
  const degHit = deg.issues?.find((i) => /enclose no area/.test(JSON.stringify(i)));
  if (degHit) ok(`  reason names the degenerate corners: ${degHit.details?.reason}`);
  else bad(`  no "enclose no area" issue; got ${JSON.stringify(deg.issues?.slice(0, 2))}`);
  if (degHit?.label_relative_path && degHit?.line_number) ok(`  points at ${degHit.label_relative_path}:${degHit.line_number}`);
  else bad('  issue does not name the file and line');

  console.log('\n--- 情境 1b: NaN 座標應被判定 INVALID ---');
  const nan = await scanSource('obb-nan', `nan-${stamp}`);
  if (nan.status === 'INVALID') ok('obb-nan -> INVALID');
  else bad(`obb-nan -> ${nan.status} (expected INVALID)`);
  const nanHit = nan.issues?.find((i) => /non-finite/.test(JSON.stringify(i)));
  if (nanHit) ok(`  reason names the non-finite value: ${nanHit.details?.reason}`);
  else bad(`  no "non-finite" issue; got ${JSON.stringify(nan.issues?.slice(0, 2))}`);

  console.log('\n--- 情境 4: 乾淨的 OBB 來源資料集不應被誤擋 ---');
  const good = await scanSource('obb-good', `good-${stamp}`);
  if (good.status === 'READY') ok('obb-good -> READY (no false positive)');
  else bad(`obb-good -> ${good.status}, issues=${JSON.stringify(good.issues?.slice(0, 3))}`);

  // ---- registered training datasets -----------------------------------------
  async function registered(relPath, name) {
    const c = await api('POST', '/training-datasets', {
      name, dataset_type_id: typeId, task_type: 'OBB', origin: 'REGISTERED', relative_path: relPath,
    });
    if (!c.body?.id) return { create_error: c.error };
    await api('POST', `/training-datasets/${c.body.id}/submit`);
    return await waitFor(async () => {
      const g = await api('GET', `/training-datasets/${c.body.id}`);
      const s = g.body?.status;
      return (s === 'READY' || s === 'FAILED' || s === 'INVALID') ? g.body : null;
    }, `${name} scan`);
  }

  console.log('\n--- 情境 2: REGISTERED 資料集中段的壞行應被全掃抓到 ---');
  const rb = await registered('registered-bad', `regbad-${stamp}`);
  if (rb.status === 'FAILED' || rb.status === 'INVALID') ok(`registered-bad -> ${rb.status}`);
  else bad(`registered-bad -> ${rb.status} (expected FAILED) — the full scan did not catch it`);
  const msg = `${rb.failure_code || ''} ${rb.failure_message || rb.error_message || ''}`;
  if (/img_002/.test(msg)) ok(`  names the offending file: ${msg.slice(0, 140)}`);
  else bad(`  message does not name img_002: ${msg.slice(0, 200)}`);

  console.log('\n--- 情境 2b: 乾淨的 REGISTERED 資料集不應被誤擋 ---');
  const ro = await registered('registered-ok', `regok-${stamp}`);
  if (ro.status === 'READY') ok('registered-ok -> READY (no false positive)');
  else bad(`registered-ok -> ${ro.status} ${ro.failure_code || ''} ${(ro.failure_message || '').slice(0, 160)}`);

  // ---- model ingest ----------------------------------------------------------
  async function ingest(url, taskType, name) {
    const c = await api('POST', '/models/ingest/url', {
      name, dataset_type_id: typeId, task_type: taskType, source_url: url,
    });
    if (!c.body?.id && !c.body?.model_ingest_task_id) return { create_error: c.error, status: c.status };
    const taskId = c.body.id || c.body.model_ingest_task_id;
    return await waitFor(async () => {
      const g = await api('GET', `/models/ingest-tasks/${taskId}`);
      const s = g.body?.status;
      return (s === 'COMPLETED' || s === 'FAILED') ? g.body : null;
    }, `${name} ingest`);
  }

  console.log('\n--- 情境 3: 宣告 OBB 但上傳 detect 權重應被擋下 ---');
  const mism = await ingest('http://assets/yolo11n.pt', 'OBB', `mismatch-${stamp}`);
  if (mism.status === 'FAILED') ok('detect weights declared OBB -> FAILED');
  else bad(`-> ${mism.status} (expected FAILED) ${JSON.stringify(mism.create_error || '')}`);
  if (mism.failure_code === 'MODEL_TASK_TYPE_MISMATCH') ok(`  code is MODEL_TASK_TYPE_MISMATCH`);
  else bad(`  code is ${mism.failure_code}`);
  if (/reports task DETECT/.test(mism.failure_message || '')) ok(`  message: ${(mism.failure_message || '').slice(0, 130)}`);
  else bad(`  message: ${(mism.failure_message || '').slice(0, 200)}`);

  console.log('\n--- 情境 3b: 宣告 OBB 且確實是 OBB 權重應成功 ---');
  const match = await ingest('http://assets/yolo11n-obb.pt', 'OBB', `match-${stamp}`);
  if (match.status === 'COMPLETED') ok('obb weights declared OBB -> COMPLETED (no false positive)');
  else bad(`-> ${match.status} ${match.failure_code || ''} ${(match.failure_message || '').slice(0, 160)}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
