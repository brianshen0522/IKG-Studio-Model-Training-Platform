import { Inject, Injectable, HttpException } from '@nestjs/common';
import { DB_PROVIDER } from '../database/database.module';
import { type Kysely, sql } from 'kysely';
import type { Database } from '@model-trainer/db';
import { errorCode } from '@model-trainer/shared-types';

const err = (code: string, message: string, status: number) =>
  new HttpException({ error: { code, message, requestId: '' } }, status);

const FIELDS = [
  'id', 'severity', 'title', 'message', 'resource_type_code', 'resource_id',
  'created_at', 'read_at',
] as const;

@Injectable()
export class NotificationsService {
  constructor(@Inject(DB_PROVIDER) private readonly db: Kysely<Database>) {}

  async list(userId: string, params: { page: number; size: number; unreadOnly: boolean; severity?: string }) {
    const size = Math.min(Math.max(params.size, 1), 100);
    const offset = (params.page - 1) * size;
    let q = this.db.selectFrom('notifications')
      .where('recipient_user_id', '=', userId).where('archived_at', 'is', null);
    if (params.unreadOnly) q = q.where('read_at', 'is', null);
    if (params.severity === 'SUCCESS' || params.severity === 'WARNING' || params.severity === 'ERROR') {
      q = q.where('severity', '=', params.severity);
    }
    const [{ count }] = await q.select(sql<number>`count(*)`.as('count')).execute();
    const items = await q.select(FIELDS).orderBy('created_at', 'desc').limit(size).offset(offset).execute();
    return { items, total: Number(count), page: params.page, size };
  }

  async unreadCount(userId: string) {
    const row = await this.db.selectFrom('notifications')
      .where('recipient_user_id', '=', userId).where('archived_at', 'is', null).where('read_at', 'is', null)
      .select(sql<number>`count(*)`.as('count')).executeTakeFirstOrThrow();
    return { unread: Number(row.count) };
  }

  async markRead(userId: string, id: string) {
    const res = await this.db.updateTable('notifications')
      .set({ read_at: sql`now()` })
      .where('id', '=', id).where('recipient_user_id', '=', userId).where('read_at', 'is', null)
      .executeTakeFirst();
    if (res.numUpdatedRows === 0n) {
      // Either not found, not owned, or already read — distinguish not-found/not-owned from idempotent re-read.
      const exists = await this.db.selectFrom('notifications').select('read_at')
        .where('id', '=', id).where('recipient_user_id', '=', userId).executeTakeFirst();
      if (!exists) throw err(errorCode.NOTIFICATION_NOT_FOUND, 'notification not found', 404);
    }
    return { id, read: true };
  }

  async markAllRead(userId: string) {
    const res = await this.db.updateTable('notifications')
      .set({ read_at: sql`now()` })
      .where('recipient_user_id', '=', userId).where('read_at', 'is', null).where('archived_at', 'is', null)
      .executeTakeFirst();
    return { marked: Number(res.numUpdatedRows) };
  }
}
