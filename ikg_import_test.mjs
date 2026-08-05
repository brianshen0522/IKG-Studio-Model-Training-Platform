import { createDb } from './packages/db/dist/index.js';
import { BackupService } from './apps/api/dist/admin/backup/backup.service.js';
import { AuditService } from './apps/api/dist/audit/audit.service.js';
import { readFileSync } from 'fs';

const { db, pool } = createDb({ host: 'localhost', port: 55432, database: 'model_trainer', user: 'migration_role', password: 'testpass' });
const svc = new BackupService(db, new AuditService(db));

async function main() {
  const payload = JSON.parse(readFileSync('/tmp/ikg_export.json', 'utf-8')).data;
  const actorId = payload.users.find((u) => u.role === 'ADMIN').id;
  try {
    const res = await svc.importData(payload, actorId);
    console.log('IMPORT OK', JSON.stringify(res));
  } catch (e) {
    console.log('ERR name=' + e.name + ' status=' + e.status + ' code=' + e.code + ' msg=' + JSON.stringify(String(e.message)));
  }
  const q = async (t) => Number((await db.selectFrom(t).select(db.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
  console.log('COUNTS', JSON.stringify({ users: await q('users'), dt: await q('dataset_types'), settings: await q('system_settings'), creds: await q('webauthn_credentials') }));
  const users = await db.selectFrom('users').select(['id','username','role','status']).orderBy('username').execute();
  for (const u of users) console.log('USER', u.username, u.role, u.status);
  await pool.end();
}
main().catch((e) => { console.log('FATAL', String(e.message)); process.exit(1); });
