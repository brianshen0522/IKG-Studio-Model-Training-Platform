import { Inject, Injectable } from '@nestjs/common';
import { DB_PROVIDER } from '../database/database.module';
import { type Kysely } from 'kysely';
import type { Database } from '@model-trainer/db';

@Injectable()
export class SystemSettingsService {
  private cache: Map<string, number> = new Map();
  private loaded = false;

  constructor(@Inject(DB_PROVIDER) private readonly db: Kysely<Database>) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const rows = await this.db
      .selectFrom('system_settings')
      .select(['setting_key', 'value'])
      .where('setting_key', 'in', [
        'auth_failed_login_threshold',
        'auth_lockout_minutes',
        'auth_session_idle_minutes',
        'auth_session_absolute_hours',
      ])
      .execute();
    for (const row of rows) {
      const v = row.value;
      if (typeof v === 'number') {
        this.cache.set(row.setting_key, v);
      } else if (typeof v === 'string') {
        this.cache.set(row.setting_key, Number(v));
      } else if (v && typeof v === 'object' && 'value' in v) {
        this.cache.set(row.setting_key, Number((v as Record<string, unknown>).value));
      } else {
        this.cache.set(row.setting_key, Number(v));
      }
    }
    this.loaded = true;
  }

  async getFailedLoginThreshold(): Promise<number> {
    await this.ensureLoaded();
    return this.cache.get('auth_failed_login_threshold') ?? 5;
  }

  async getLockoutMinutes(): Promise<number> {
    await this.ensureLoaded();
    return this.cache.get('auth_lockout_minutes') ?? 15;
  }

  async getSessionIdleMinutes(): Promise<number> {
    await this.ensureLoaded();
    return this.cache.get('auth_session_idle_minutes') ?? 480;
  }

  async getSessionAbsoluteHours(): Promise<number> {
    await this.ensureLoaded();
    return this.cache.get('auth_session_absolute_hours') ?? 24;
  }

  invalidateCache(): void {
    this.cache.clear();
    this.loaded = false;
  }
}
