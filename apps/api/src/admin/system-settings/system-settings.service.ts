import { Inject, Injectable, HttpException } from '@nestjs/common';
import { DB_PROVIDER } from '../../database/database.module';
import { type Kysely, sql } from 'kysely';
import type { Database } from '@model-trainer/db';
import { errorCode } from '@model-trainer/shared-types';
import { AuditService } from '../../audit/audit.service';

const FIELDS = ['setting_key', 'value', 'description', 'is_secret', 'updated_at'] as const;

const err = (code: string, message: string, status: number) =>
  new HttpException({ error: { code, message, requestId: '' } }, status);

@Injectable()
export class SystemSettingsService {
  constructor(
    @Inject(DB_PROVIDER) private readonly db: Kysely<Database>,
    private readonly auditService: AuditService,
  ) {}

  async list() {
    const rows = await this.db.selectFrom('system_settings').select(FIELDS)
      .orderBy('setting_key').execute();
    return rows.map((r) => ({
      ...r,
      value: r.is_secret ? null : r.value,
    }));
  }

  async update(key: string, value: unknown, actorUserId: string) {
    const row = await this.db.selectFrom('system_settings').select(['setting_key', 'is_secret', 'value'])
      .where('setting_key', '=', key).executeTakeFirst();
    if (!row) throw err(errorCode.RESOURCE_NOT_FOUND, `system setting '${key}' not found`, 404);
    if (row.is_secret) throw err(errorCode.VALIDATION_FAILED, 'secret settings cannot be edited here', 400);

    // JSON-stringify + cast: node-pg only auto-serialises objects/arrays, not scalar
    // numbers/booleans/strings — and these settings are scalars (e.g. 85, true).
    await this.db.updateTable('system_settings')
      .set({
        value: sql`${JSON.stringify(value ?? null)}::jsonb`,
        updated_at: sql`now()`,
        updated_by_user_id: actorUserId,
      })
      .where('setting_key', '=', key).execute();

    const updated = await this.db.selectFrom('system_settings').select(FIELDS)
      .where('setting_key', '=', key).executeTakeFirstOrThrow();

    await this.auditService.append({
      actorType: 'USER', actorUserId, actionCode: 'SYSTEM_SETTING_UPDATED',
      resourceTypeCode: 'SYSTEM_SETTING', resourceId: '00000000-0000-0000-0000-000000000000',
      result: 'SUCCESS',
      metadata: { setting_key: key, before: row.value, after: value },
    });

    return updated;
  }
}
