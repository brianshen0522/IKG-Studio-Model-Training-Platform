// The wizard refuses a generation with no official weights for the dataset's task,
// but the API took the same request happily — this checks the server, by asking it
// directly rather than through the picker that already knows better.
const BASE = process.env.QA_URL || 'http://localhost:8088';
const PASSWORD = process.env.QA_ADMIN_PASSWORD || 'AdminPass123!';
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
const login = await api('POST', '/auth/login', { username: 'admin', password: PASSWORD });
csrf = login.body.csrfToken; ok('logged in');

let tds = (await api('GET', '/training-datasets')).body;
tds = (Array.isArray(tds) ? tds : tds?.items ?? []).filter(d => d.status === 'READY');
const obb = tds.find(d => d.task_type === 'OBB');
const det = tds.find(d => d.task_type === 'DETECT');
if (!obb || !det) { console.log('need a READY OBB and DETECT dataset; run the other suites first'); process.exit(1); }

const stamp = Date.now().toString(36);
async function submit(label, dataset, version, size) {
  const r = await api('POST', '/training-jobs', {
    name: `guard-${label}-${stamp}`, training_dataset_id: dataset.id,
    hyperparameters: { epochs: 1, imgsz: 320, batch: 2, yolo_version: version, yolo_size: size },
  });
  return r;
}

console.log('\n--- 官方權重不存在的組合必須在提交時被擋 ---');
for (const [ver, size] of [['v12', 'n'], ['v9', 'c'], ['v10', 'b']]) {
  const r = await submit(`${ver}obb`, obb, ver, size);
  const msg = r.error?.message ?? '';
  r.status === 400 && /no official OBB weights/i.test(msg)
    ? ok(`${ver}${size} + OBB -> 400: ${msg.slice(0, 92)}`)
    : bad(`${ver}${size} + OBB -> ${r.status} ${JSON.stringify(r.error ?? r.body).slice(0, 140)}`);
}

console.log('\n--- 不存在的 scale 也要擋（v8 沒有 "t"）---');
{
  const r = await submit('v8t', det, 'v8', 't');
  const msg = r.error?.message ?? '';
  r.status === 400 && /scale/i.test(msg)
    ? ok(`v8t -> 400: ${msg.slice(0, 92)}`)
    : bad(`v8t -> ${r.status} ${JSON.stringify(r.error ?? r.body).slice(0, 140)}`);
}

console.log('\n--- 存在的組合不可誤擋 ---');
for (const [ds, ver, size, what] of [[obb, 'v11', 'n', 'OBB'], [obb, 'v8', 's', 'OBB'], [det, 'v12', 'n', 'DETECT']]) {
  const r = await submit(`ok-${ver}${size}`, ds, ver, size);
  r.status >= 200 && r.status < 300
    ? ok(`${ver}${size} + ${what} -> 接受`)
    : bad(`${ver}${size} + ${what} -> ${r.status} ${JSON.stringify(r.error ?? '').slice(0, 140)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
