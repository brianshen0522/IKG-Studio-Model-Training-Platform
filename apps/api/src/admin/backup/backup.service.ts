import { Inject, Injectable, HttpException } from '@nestjs/common';
import { DB_PROVIDER } from '../../database/database.module';
import { type Kysely, type Transaction, sql } from 'kysely';
import type { Database } from '@model-trainer/db';
import { errorCode } from '@model-trainer/shared-types';
import { AuditService } from '../../audit/audit.service';

const FORMAT = 'ikg-backup';
const VERSION = 1;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

const err = (code: string, message: string, status: number) =>
  new HttpException({ error: { code, message, requestId: '' } }, status);

type Exec = Kysely<Database> | Transaction<Database>;

// `sql` produces RawBuilder<unknown>; Kysely's ValueExpression requires the column type,
// so every jsonb write goes through an explicit `never` cast — the DB casts on its side.
const jsonb = (v: unknown) => sql`${JSON.stringify(v ?? null)}::jsonb` as never;

interface BackupPayload {
  format: string;
  version: number;
  dataset_types: DatasetTypeRow[];
  system_settings: SettingRow[];
  users: UserRow[];
  webauthn_credentials: CredentialRow[];
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  password_hash: string;
  role: string;
  status: string;
  failed_login_count: number;
  locked_until: string | null;
  last_login_at: string | null;
  password_updated_at: string | null;
  must_change_password: boolean;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  disabled_by_user_id: string | null;
  disabled_at: string | null;
}

interface DatasetTypeRow {
  id: string;
  name: string;
  parent_id: string | null;
  description: string | null;
  icon: string | null;
  color: string | null;
  sort_order: number;
  enabled: boolean;
  is_system: boolean;
  dataset_path: string | null;
  model_path: string | null;
  training_dataset_path: string | null;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
}

interface SettingRow {
  setting_key: string;
  value: unknown;
  value_schema_version: number;
  description: string | null;
  is_secret: boolean;
}

interface CredentialRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: unknown;
  device_type: string | null;
  backed_up: boolean;
  name: string;
  aaguid: string | null;
}

@Injectable()
export class BackupService {
  constructor(
    @Inject(DB_PROVIDER) private readonly db: Kysely<Database>,
    private readonly auditService: AuditService,
  ) {}

  async exportData(actorId: string) {
    const [dataset_types, system_settings, users, webauthn_credentials] = await Promise.all([
      this.db.selectFrom('dataset_types').selectAll().orderBy('sort_order').orderBy('name').execute(),
      this.db.selectFrom('system_settings').selectAll().orderBy('setting_key').execute(),
      this.db.selectFrom('users').selectAll().orderBy('username').execute(),
      this.db.selectFrom('webauthn_credentials').selectAll().execute(),
    ]);

    await this.auditService.append({
      actorType: 'USER',
      actorUserId: actorId,
      actionCode: 'ADMIN_DATA_EXPORTED',
      resourceTypeCode: 'SYSTEM_SETTING',
      resourceId: ZERO_UUID,
      result: 'SUCCESS',
      metadata: {
        users: users.length,
        dataset_types: dataset_types.length,
        system_settings: system_settings.length,
        webauthn_credentials: webauthn_credentials.length,
      },
    });

    return {
      format: FORMAT,
      version: VERSION,
      exported_at: new Date().toISOString(),
      dataset_types,
      system_settings,
      users,
      webauthn_credentials,
    };
  }

  private validatePayload(payload: unknown): BackupPayload {
    const p = payload as Partial<Record<keyof BackupPayload, unknown>>;
    if (!p || typeof p !== 'object') {
      throw err(errorCode.VALIDATION_FAILED, 'invalid backup payload', 400);
    }
    if (p.format !== FORMAT) {
      throw err(errorCode.VALIDATION_FAILED, 'not an ikg-backup file', 400);
    }
    if (p.version !== VERSION) {
      throw err(errorCode.VALIDATION_FAILED, `unsupported backup version ${String(p.version)}`, 400);
    }
    for (const key of ['dataset_types', 'system_settings', 'users', 'webauthn_credentials'] as const) {
      if (!Array.isArray(p[key])) {
        throw err(errorCode.VALIDATION_FAILED, `backup is missing '${key}' array`, 400);
      }
    }

    const users = p.users as unknown as UserRow[];
    const typeIds = new Set((p.dataset_types as unknown as DatasetTypeRow[]).map((t) => t.id));
    const userIds = new Set(users.map((u) => u.id));
    const seenIds = new Set<string>();

    for (const u of users) {
      if (!u.id || typeof u.id !== 'string') throw err(errorCode.VALIDATION_FAILED, 'user missing id', 400);
      if (seenIds.has(u.id)) throw err(errorCode.VALIDATION_FAILED, `duplicate user id ${u.id}`, 400);
      seenIds.add(u.id);
      for (const f of ['username', 'display_name', 'password_hash', 'role', 'status'] as const) {
        if (typeof u[f] !== 'string' || !u[f]) throw err(errorCode.VALIDATION_FAILED, `user ${u.id} missing ${f}`, 400);
      }
    }

    seenIds.clear();
    for (const t of p.dataset_types as unknown as DatasetTypeRow[]) {
      if (!t.id || typeof t.id !== 'string') throw err(errorCode.VALIDATION_FAILED, 'dataset type missing id', 400);
      if (seenIds.has(t.id)) throw err(errorCode.VALIDATION_FAILED, `duplicate dataset type id ${t.id}`, 400);
      seenIds.add(t.id);
      if (t.parent_id != null && !typeIds.has(t.parent_id)) {
        throw err(errorCode.VALIDATION_FAILED, `dataset type ${t.id} references unknown parent ${t.parent_id}`, 400);
      }
    }

    for (const c of p.webauthn_credentials as unknown as CredentialRow[]) {
      if (!userIds.has(c.user_id)) {
        throw err(errorCode.VALIDATION_FAILED, `webauthn credential references unknown user ${String(c.user_id)}`, 400);
      }
    }

    return p as BackupPayload;
  }

  /** Delete leaves-first: self-referencing parent_id is ON DELETE RESTRICT. */
  private async deleteAllDatasetTypes(trx: Transaction<Database>) {
    for (;;) {
      const res = await trx
        .deleteFrom('dataset_types')
        .where('id', 'not in', (qb) =>
          qb.selectFrom('dataset_types').select('parent_id').where('parent_id', 'is not', null))
        .execute();
      const deleted = (Array.isArray(res) ? res[0] : res)?.numDeletedRows;
      if (Number(deleted ?? 0) === 0) break;
    }
  }

  private async insertUsers(trx: Transaction<Database>, rows: UserRow[], idMap: Map<string, string>) {
    const mapRef = (v: string | null) => (v == null ? null : (idMap.get(v) ?? null));

    // Insert with self-references nulled, then fix them up: RESTRICT self-FK means the
    // referenced row must already exist, so a two-pass avoids ordering concerns entirely.
    for (const row of rows) {
      await trx
        .insertInto('users')
        .values({
          id: row.id,
          username: row.username,
          display_name: row.display_name,
          email: row.email,
          password_hash: row.password_hash,
          role: row.role as never,
          status: row.status as never,
          failed_login_count: row.failed_login_count ?? 0,
          locked_until: row.locked_until,
          last_login_at: row.last_login_at,
          password_updated_at: row.password_updated_at ?? undefined,
          must_change_password: row.must_change_password ?? false,
          created_by_user_id: null,
          updated_by_user_id: null,
          disabled_by_user_id: null,
          disabled_at: row.disabled_at,
        })
        .execute();
    }
    for (const row of rows) {
      await trx
        .updateTable('users')
        .set({
          created_by_user_id: mapRef(row.created_by_user_id),
          updated_by_user_id: mapRef(row.updated_by_user_id),
          disabled_by_user_id: mapRef(row.disabled_by_user_id),
        })
        .where('id', '=', row.id)
        .execute();
    }
  }

  /** Insert parents before children: parent_id is ON DELETE RESTRICT. */
  private async insertDatasetTypes(trx: Transaction<Database>, rows: DatasetTypeRow[], idMap: Map<string, string>) {
    const mapRef = (v: string | null) => (v == null ? null : (idMap.get(v) ?? null));
    const remaining = new Set(rows.map((r) => r.id));
    const inserted = new Set<string>();

    while (remaining.size > 0) {
      let progress = false;
      for (const row of rows) {
        if (!remaining.has(row.id)) continue;
        if (row.parent_id != null && !inserted.has(row.parent_id)) continue;
        await trx
          .insertInto('dataset_types')
          .values({
            id: row.id,
            name: row.name,
            parent_id: row.parent_id,
            description: row.description,
            icon: row.icon,
            color: row.color,
            sort_order: row.sort_order ?? 0,
            enabled: row.enabled ?? true,
            is_system: row.is_system ?? false,
            dataset_path: row.dataset_path as never,
            model_path: row.model_path as never,
            training_dataset_path: row.training_dataset_path,
            created_by_user_id: mapRef(row.created_by_user_id),
            updated_by_user_id: mapRef(row.updated_by_user_id),
          })
          .execute();
        remaining.delete(row.id);
        inserted.add(row.id);
        progress = true;
      }
      if (!progress) {
        throw err(errorCode.VALIDATION_FAILED, 'dataset type hierarchy contains a cycle', 400);
      }
    }
  }

  async importData(payload: unknown, actorId: string) {
    const p = this.validatePayload(payload);
    const users = p.users;
    const credentials = p.webauthn_credentials;
    const settings = p.system_settings;

    // ── Admin identity handover ─────────────────────────────────────────────
    // The actor (currently logged-in admin) must survive the overwrite so their
    // session and audit history stay valid. Prefer a payload user whose id already
    // equals the actor's; otherwise adopt the first ADMIN from the payload into the
    // actor's row (keeping the actor's id) and drop that ADMIN from the insert set.
    const actorInPayload = users.find((u) => u.id === actorId);
    const adopted = actorInPayload ?? users.find((u) => u.role === 'ADMIN');
    const idMap = new Map<string, string>();
    for (const u of users) {
      idMap.set(u.id, adopted && u.id === adopted.id ? actorId : u.id);
    }

    try {
      await this.db.transaction().execute(async (trx) => {
        // ── Clear current state (FK-safe order) ─────────────────────────────
        await trx.deleteFrom('webauthn_challenges').execute();
        await trx.deleteFrom('webauthn_credentials').execute();
        await trx.deleteFrom('user_sessions').where('user_id', '!=', actorId).execute();
        await trx.deleteFrom('system_settings').execute();
        await this.deleteAllDatasetTypes(trx);
        await trx.deleteFrom('users').where('id', '!=', actorId).execute();

        // ── Adopt admin identity into the actor's row ───────────────────────
        if (adopted && adopted.id !== actorId) {
          await trx
            .updateTable('users')
            .set({
              username: adopted.username,
              display_name: adopted.display_name,
              email: adopted.email,
              password_hash: adopted.password_hash,
              role: 'ADMIN',
              status: adopted.status as never,
              failed_login_count: adopted.failed_login_count ?? 0,
              locked_until: adopted.locked_until,
              last_login_at: adopted.last_login_at,
              password_updated_at: adopted.password_updated_at ?? undefined,
              must_change_password: adopted.must_change_password ?? false,
            })
            .where('id', '=', actorId)
            .execute();
        }

        // ── Insert payload rows (adopted ADMIN excluded from users) ─────────
        const usersToInsert = adopted ? users.filter((u) => u.id !== adopted.id) : users;
        await this.insertUsers(trx, usersToInsert, idMap);

        await this.insertDatasetTypes(trx, p.dataset_types, idMap);

        for (const c of credentials) {
          await trx
            .insertInto('webauthn_credentials')
            .values({
              id: c.id,
              user_id: idMap.get(c.user_id) ?? c.user_id,
              credential_id: c.credential_id,
              public_key: c.public_key,
              counter: c.counter ?? 0,
              transports: jsonb(c.transports ?? []),
              device_type: c.device_type,
              backed_up: c.backed_up ?? false,
              name: c.name,
              aaguid: c.aaguid,
            })
            .execute();
        }

        for (const s of settings) {
          await trx
            .insertInto('system_settings')
            .values({
              setting_key: s.setting_key,
              value: jsonb(s.value),
              value_schema_version: s.value_schema_version ?? 1,
              description: s.description,
              is_secret: s.is_secret ?? false,
              updated_by_user_id: null,
            })
            .execute();
        }

        await this.auditService.append({
          actorType: 'USER',
          actorUserId: actorId,
          actionCode: 'ADMIN_DATA_IMPORTED',
          resourceTypeCode: 'SYSTEM_SETTING',
          resourceId: ZERO_UUID,
          result: 'SUCCESS',
          metadata: {
            users: users.length,
            dataset_types: p.dataset_types.length,
            system_settings: settings.length,
            webauthn_credentials: credentials.length,
          },
        }, trx);
      });
    } catch (e) {
      if (e instanceof HttpException) throw e;
      const code = (e as { code?: string }).code;
      if (code === '23503') {
        throw err(errorCode.RESOURCE_CONFLICT,
          'system contains data that references users or dataset types; overwrite import is only supported on a fresh/empty system', 409);
      }
      throw e;
    }

    return {
      users: users.length,
      dataset_types: p.dataset_types.length,
      system_settings: settings.length,
      webauthn_credentials: credentials.length,
    };
  }
}
