import { Inject, Injectable, HttpException } from '@nestjs/common';
import { DB_PROVIDER } from '../../database/database.module';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { Database, UserRole, UserStatus } from '@model-trainer/db';
import { errorCode } from '@model-trainer/shared-types';
import { PasswordService } from '../../auth/password.service';
import { SessionService } from '../../auth/session.service';
import { AuditService } from '../../audit/audit.service';
import { OutboxService } from '../../outbox/outbox.service';

const USER_SELECT_FIELDS = [
  'id', 'username', 'display_name', 'email', 'role', 'status',
  'must_change_password', 'last_login_at', 'password_updated_at',
  'created_at', 'created_by_user_id', 'updated_at', 'updated_by_user_id',
  'disabled_at', 'disabled_by_user_id', 'row_version',
] as const;

const SORT_WHITELIST = ['created_at', 'username', 'last_login_at', 'status'] as const;

interface ListParams {
  q?: string;
  role?: UserRole;
  status?: UserStatus;
  page: number;
  size: number;
  sort?: string;
  order?: 'asc' | 'desc';
}

interface CreateParams {
  username: string;
  display_name: string;
  email?: string | null;
  role: UserRole;
  password_mode: 'MANUAL' | 'GENERATED';
  password?: string;
}

interface UpdateParams {
  display_name?: string;
  email?: string | null;
  role?: UserRole;
  row_version: number;
}

interface StatusChangeParams {
  reason?: string;
}

@Injectable()
export class AdminUsersService {
  constructor(
    @Inject(DB_PROVIDER) private readonly db: Kysely<Database>,
    private readonly passwordService: PasswordService,
    private readonly sessionService: SessionService,
    private readonly auditService: AuditService,
    private readonly outboxService: OutboxService,
  ) {}

  async list(params: ListParams) {
    const size = Math.min(Math.max(params.size, 1), 100);
    const offset = (params.page - 1) * size;
    const sort = SORT_WHITELIST.includes(params.sort as typeof SORT_WHITELIST[number])
      ? (params.sort as string)
      : 'created_at';
    const order = params.order === 'asc' ? 'asc' : 'desc';

    let query = this.db
      .selectFrom('users')
      .select(USER_SELECT_FIELDS);

    if (params.q) {
      const q = `%${params.q}%`;
      query = query.where((eb) =>
        eb.or([
          eb('username', 'ilike', q),
          eb('display_name', 'ilike', q),
          eb('email', 'ilike', q),
        ]),
      );
    }
    if (params.role) {
      query = query.where('role', '=', params.role);
    }
    if (params.status) {
      query = query.where('status', '=', params.status);
    }

    const [{ count }] = await this.db
      .selectFrom(query.orderBy('created_at', 'desc').limit(1).as('sub'))
      .select(sql<number>`count(*)`.as('count'))
      .execute();

    const items = await query
      .orderBy(sql.ref(sort), order)
      .limit(size)
      .offset(offset)
      .execute();

    return { items, total: Number(count), page: params.page, size };
  }

  async create(params: CreateParams, actor: { id: string; role: string }) {
    const username = params.username.trim();
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) {
      throw new HttpException(
        { error: { code: errorCode.VALIDATION_FAILED, message: 'Username must be 3-64 chars: a-zA-Z0-9._-', requestId: '' } },
        400,
      );
    }
    const displayName = params.display_name.trim();
    if (!displayName || displayName.length > 100) {
      throw new HttpException(
        { error: { code: errorCode.VALIDATION_FAILED, message: 'Display name must be 1-100 characters', requestId: '' } },
        400,
      );
    }

    let tempPassword: string | undefined;

    if (params.password_mode === 'MANUAL') {
      if (!params.password) {
        throw new HttpException(
          { error: { code: errorCode.VALIDATION_FAILED, message: 'Password is required in MANUAL mode', requestId: '' } },
          400,
        );
      }
      const policyError = this.passwordService.validatePolicy(params.password, username, displayName);
      if (policyError) {
        throw new HttpException(
          { error: { code: errorCode.AUTH_PASSWORD_POLICY_FAILED, message: policyError, requestId: '' } },
          400,
        );
      }
    }

    const correlationId = crypto.randomUUID();
    const result = await this.db.transaction().execute(async (trx) => {
      const existingUsername = await trx
        .selectFrom('users')
        .select('id')
        .where('username', '=', username)
        .executeTakeFirst();
      if (existingUsername) {
        throw new HttpException(
          { error: { code: errorCode.USER_USERNAME_ALREADY_EXISTS, message: 'Username already exists', requestId: '' } },
          409,
        );
      }

      if (params.email) {
        const existingEmail = await trx
          .selectFrom('users')
          .select('id')
          .where('email', '=', params.email.trim())
          .executeTakeFirst();
        if (existingEmail) {
          throw new HttpException(
            { error: { code: errorCode.USER_EMAIL_ALREADY_EXISTS, message: 'Email already exists', requestId: '' } },
            409,
          );
        }
      }

      const password = params.password_mode === 'GENERATED'
        ? this.passwordService.generateTemporaryPassword()
        : params.password!;
      const passwordHash = await this.passwordService.hash(password);

      if (params.password_mode === 'GENERATED') {
        tempPassword = password;
      }

      const userId = await trx
        .insertInto('users')
        .values({
          username,
          display_name: displayName,
          email: params.email?.trim() ?? null,
          password_hash: passwordHash,
          role: params.role,
          status: 'ACTIVE',
          must_change_password: false,
          created_by_user_id: actor.id,
          updated_by_user_id: actor.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
        .then((r) => r.id);

      await this.auditService.append({
        actorType: 'USER',
        actorUserId: actor.id,
        actionCode: 'USER_CREATED',
        resourceTypeCode: 'USER',
        resourceId: userId,
        result: 'SUCCESS',
        correlationId,
        afterSnapshot: { id: userId, username, display_name: displayName, email: params.email ?? null, role: params.role, status: 'ACTIVE', must_change_password: false },
      }, trx);

      return userId;
    });

    const user = await this.db
      .selectFrom('users')
      .select(USER_SELECT_FIELDS)
      .where('id', '=', result)
      .executeTakeFirst();

    return { user, tempPassword };
  }

  async findById(id: string) {
    const user = await this.db
      .selectFrom('users')
      .select(USER_SELECT_FIELDS)
      .where('id', '=', id)
      .executeTakeFirst();

    if (!user) {
      throw new HttpException(
        { error: { code: errorCode.USER_NOT_FOUND, message: 'User not found', requestId: '' } },
        404,
      );
    }
    return user;
  }

  async update(id: string, params: UpdateParams, actor: { id: string; role: string }) {
    const correlationId = crypto.randomUUID();

    return this.db.transaction().execute(async (trx) => {
      const user = await trx
        .selectFrom('users')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();

      if (!user) {
        throw new HttpException(
          { error: { code: errorCode.USER_NOT_FOUND, message: 'User not found', requestId: '' } },
          404,
        );
      }

      if (user.row_version !== params.row_version) {
        throw new HttpException(
          { error: { code: errorCode.USER_CONCURRENT_UPDATE, message: 'User was modified by another request', details: { current_row_version: user.row_version }, requestId: '' } },
          409,
        );
      }

      if (params.role !== undefined && params.role !== user.role && id === actor.id) {
        throw new HttpException(
          { error: { code: errorCode.VALIDATION_FAILED, message: 'Cannot change your own role', requestId: '' } },
          400,
        );
      }

      const beforeSnapshot: Record<string, unknown> = {
        display_name: user.display_name,
        email: user.email,
        role: user.role,
      };

      const setValues: Record<string, unknown> = {};
      const afterDisplayName = params.display_name !== undefined ? params.display_name.trim() : user.display_name;
      const afterEmail = params.email !== undefined ? (params.email?.trim() ?? null) : user.email;
      const afterRole = params.role !== undefined ? params.role : user.role;

      if (params.display_name !== undefined) setValues.display_name = params.display_name.trim();
      if (params.email !== undefined) setValues.email = params.email?.trim() ?? null;
      if (params.role !== undefined) setValues.role = params.role;

      if (params.role !== undefined && params.role !== user.role) {
        await this.assertNotLastActiveAdmin(trx, id, 'demote the last active ADMIN');
      }

      setValues.row_version = sql`row_version + 1`;
      setValues.updated_at = sql`now()`;
      setValues.updated_by_user_id = actor.id;

      if (params.email) {
        const existingEmail = await trx
          .selectFrom('users')
          .select('id')
          .where('email', '=', params.email.trim())
          .where('id', '!=', id)
          .executeTakeFirst();
        if (existingEmail) {
          throw new HttpException(
            { error: { code: errorCode.USER_EMAIL_ALREADY_EXISTS, message: 'Email already exists', requestId: '' } },
            409,
          );
        }
      }

      await trx
        .updateTable('users')
        .set(setValues)
        .where('id', '=', id)
        .execute();

      const afterSnapshot: Record<string, unknown> = {
        display_name: afterDisplayName,
        email: afterEmail,
        role: afterRole,
      };

      const diff: Record<string, unknown> = {};
      for (const key of ['display_name', 'email', 'role'] as const) {
        if (String(beforeSnapshot[key]) !== String(afterSnapshot[key])) {
          diff[key] = { before: beforeSnapshot[key], after: afterSnapshot[key] };
        }
      }

      await this.auditService.append({
        actorType: 'USER',
        actorUserId: actor.id,
        actionCode: 'USER_UPDATED',
        resourceTypeCode: 'USER',
        resourceId: id,
        result: 'SUCCESS',
        correlationId,
        beforeSnapshot,
        afterSnapshot,
        diff,
      }, trx);

      if (params.role !== undefined && params.role !== user.role) {
        await this.auditService.append({
          actorType: 'USER',
          actorUserId: actor.id,
          actionCode: 'USER_ROLE_CHANGED',
          resourceTypeCode: 'USER',
          resourceId: id,
          result: 'SUCCESS',
          correlationId,
          beforeSnapshot: { role: user.role },
          afterSnapshot: { role: params.role },
          diff: { role: { before: user.role, after: params.role } },
        }, trx);

        await this.outboxService.enqueue({
          eventType: 'user.sessions.revoke',
          aggregateTypeCode: 'USER',
          aggregateId: id,
          payload: { user_id: id, reason: 'USER_ROLE_CHANGED', except_session_id: null },
          correlationId,
        }, trx);
      }

      const updated = await trx
        .selectFrom('users')
        .select(USER_SELECT_FIELDS)
        .where('id', '=', id)
        .executeTakeFirst();

      return updated;
    });
  }

  async disable(id: string, params: StatusChangeParams, actor: { id: string; role: string }) {
    if (id === actor.id) {
      throw new HttpException(
        { error: { code: errorCode.USER_CANNOT_DISABLE_SELF, message: 'Cannot disable yourself', requestId: '' } },
        409,
      );
    }

    const correlationId = crypto.randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const user = await trx
        .selectFrom('users')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();

      if (!user) {
        throw new HttpException(
          { error: { code: errorCode.USER_NOT_FOUND, message: 'User not found', requestId: '' } },
          404,
        );
      }

      if (user.status === 'DISABLED') {
        throw new HttpException(
          { error: { code: errorCode.USER_ALREADY_DISABLED, message: 'User is already disabled', requestId: '' } },
          409,
        );
      }

      await this.assertNotLastActiveAdmin(trx, id, 'disable the last active ADMIN');

      const beforeSnapshot: Record<string, unknown> = {
        status: user.status, disabled_at: user.disabled_at, disabled_by_user_id: user.disabled_by_user_id,
      };

      await trx
        .updateTable('users')
        .set({ status: 'DISABLED', disabled_at: sql`now()`, disabled_by_user_id: actor.id, updated_at: sql`now()`, updated_by_user_id: actor.id })
        .where('id', '=', id)
        .execute();

      const afterSnapshot: Record<string, unknown> = { status: 'DISABLED' };

      await this.auditService.append({
        actorType: 'USER',
        actorUserId: actor.id,
        actionCode: 'USER_DISABLED',
        resourceTypeCode: 'USER',
        resourceId: id,
        result: 'SUCCESS',
        correlationId,
        beforeSnapshot,
        afterSnapshot,
        diff: { status: { before: user.status, after: 'DISABLED' } },
        metadata: { reason: params.reason ?? null },
      }, trx);

      await this.outboxService.enqueue({
        eventType: 'user.sessions.revoke',
        aggregateTypeCode: 'USER',
        aggregateId: id,
        payload: { user_id: id, reason: 'USER_DISABLED', except_session_id: null },
        correlationId,
      }, trx);

      return this.findById(id);
    });
  }

  async enable(id: string, params: StatusChangeParams, actor: { id: string; role: string }) {
    const correlationId = crypto.randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const user = await trx
        .selectFrom('users')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();

      if (!user) {
        throw new HttpException(
          { error: { code: errorCode.USER_NOT_FOUND, message: 'User not found', requestId: '' } },
          404,
        );
      }

      if (user.status === 'ACTIVE') {
        throw new HttpException(
          { error: { code: errorCode.USER_ALREADY_ACTIVE, message: 'User is already active', requestId: '' } },
          409,
        );
      }

      if (user.status !== 'DISABLED') {
        throw new HttpException(
          { error: { code: errorCode.USER_INVALID_STATUS_TRANSITION, message: 'Can only enable a disabled user', requestId: '' } },
          409,
        );
      }

      const beforeSnapshot: Record<string, unknown> = {
        status: user.status, disabled_at: user.disabled_at, disabled_by_user_id: user.disabled_by_user_id,
      };

      await trx
        .updateTable('users')
        .set({
          status: 'ACTIVE', failed_login_count: 0, locked_until: null,
          disabled_at: null, disabled_by_user_id: null,
          updated_at: sql`now()`, updated_by_user_id: actor.id,
        })
        .where('id', '=', id)
        .execute();

      await this.auditService.append({
        actorType: 'USER',
        actorUserId: actor.id,
        actionCode: 'USER_ENABLED',
        resourceTypeCode: 'USER',
        resourceId: id,
        result: 'SUCCESS',
        correlationId,
        beforeSnapshot,
        afterSnapshot: { status: 'ACTIVE' },
        diff: { status: { before: user.status, after: 'ACTIVE' } },
        metadata: { reason: params.reason ?? null },
      }, trx);

      return this.findById(id);
    });
  }

  async unlock(id: string, params: StatusChangeParams, actor: { id: string; role: string }) {
    const correlationId = crypto.randomUUID();
    return this.db.transaction().execute(async (trx) => {
      const user = await trx
        .selectFrom('users')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();

      if (!user) {
        throw new HttpException(
          { error: { code: errorCode.USER_NOT_FOUND, message: 'User not found', requestId: '' } },
          404,
        );
      }

      if (user.status !== 'LOCKED') {
        throw new HttpException(
          { error: { code: errorCode.USER_NOT_LOCKED, message: 'User is not locked', requestId: '' } },
          409,
        );
      }

      const beforeSnapshot: Record<string, unknown> = {
        status: user.status, locked_until: user.locked_until, failed_login_count: user.failed_login_count,
      };

      await trx
        .updateTable('users')
        .set({
          status: 'ACTIVE', failed_login_count: 0, locked_until: null,
          updated_at: sql`now()`, updated_by_user_id: actor.id,
        })
        .where('id', '=', id)
        .execute();

      await this.auditService.append({
        actorType: 'USER',
        actorUserId: actor.id,
        actionCode: 'USER_UNLOCKED',
        resourceTypeCode: 'USER',
        resourceId: id,
        result: 'SUCCESS',
        correlationId,
        beforeSnapshot,
        afterSnapshot: { status: 'ACTIVE' },
        diff: { status: { before: 'LOCKED', after: 'ACTIVE' } },
        metadata: { reason: params.reason ?? null },
      }, trx);

      return this.findById(id);
    });
  }

  async setPassword(id: string, newPassword: string, actor: { id: string; role: string }) {
    const correlationId = crypto.randomUUID();

    return this.db.transaction().execute(async (trx) => {
      const user = await trx
        .selectFrom('users')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();

      if (!user) {
        throw new HttpException(
          { error: { code: errorCode.USER_NOT_FOUND, message: 'User not found', requestId: '' } },
          404,
        );
      }

      const passwordHash = await this.passwordService.hash(newPassword);

      await trx
        .updateTable('users')
        .set({
          password_hash: passwordHash,
          password_updated_at: sql`now()`,
          must_change_password: false,
          updated_at: sql`now()`,
          updated_by_user_id: actor.id,
        })
        .where('id', '=', id)
        .execute();

      await this.auditService.append({
        actorType: 'USER',
        actorUserId: actor.id,
        actionCode: 'USER_PASSWORD_RESET',
        resourceTypeCode: 'USER',
        resourceId: id,
        result: 'SUCCESS',
        correlationId,
        metadata: { username: user.username },
      }, trx);

      await this.outboxService.enqueue({
        eventType: 'user.sessions.revoke',
        aggregateTypeCode: 'USER',
        aggregateId: id,
        payload: { user_id: id, reason: 'USER_PASSWORD_RESET', except_session_id: null },
        correlationId,
      }, trx);

      return {};
    });
  }

  async getSessions(id: string) {
    const user = await this.db.selectFrom('users').select('id').where('id', '=', id).executeTakeFirst();
    if (!user) {
      throw new HttpException(
        { error: { code: errorCode.USER_NOT_FOUND, message: 'User not found', requestId: '' } },
        404,
      );
    }
    return this.sessionService.getUserSessions(id);
  }

  async deleteSession(userId: string, sessionId: string, actor: { id: string; role: string }) {
    const user = await this.db.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst();
    if (!user) {
      throw new HttpException(
        { error: { code: errorCode.USER_NOT_FOUND, message: 'User not found', requestId: '' } },
        404,
      );
    }

    const found = await this.sessionService.revokeSessionById(sessionId, userId, 'ADMIN_REVOKED');
    if (!found) {
      throw new HttpException(
        { error: { code: errorCode.RESOURCE_NOT_FOUND, message: 'Session not found', requestId: '' } },
        404,
      );
    }

    await this.auditService.append({
      actorType: 'USER',
      actorUserId: actor.id,
      actionCode: 'AUTH_SESSION_REVOKED',
      resourceTypeCode: 'USER',
      resourceId: userId,
      result: 'SUCCESS',
      metadata: { session_id: sessionId, target_user_id: userId },
    });
  }

  async revokeAllSessions(userId: string, actor: { id: string; role: string }) {
    const user = await this.db.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst();
    if (!user) {
      throw new HttpException(
        { error: { code: errorCode.USER_NOT_FOUND, message: 'User not found', requestId: '' } },
        404,
      );
    }

    const correlationId = crypto.randomUUID();

    const count = await this.sessionService.revokeAllForUser(userId);
    await this.auditService.append({
      actorType: 'USER',
      actorUserId: actor.id,
      actionCode: 'USER_SESSIONS_REVOKED',
      resourceTypeCode: 'USER',
      resourceId: userId,
      result: 'SUCCESS',
      correlationId,
      metadata: { target_user_id: userId, revoked_count: count },
    });

    return { revokedCount: count };
  }

  private async assertNotLastActiveAdmin(trx: Transaction<Database>, userId: string, action: string): Promise<void> {
    const user = await trx
      .selectFrom('users')
      .select('role')
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirst();

    if (!user || user.role !== 'ADMIN') return;

    const { count } = await trx
      .selectFrom('users')
      .select(sql<number>`count(*)`.as('count'))
      .where('role', '=', 'ADMIN')
      .where('status', '=', 'ACTIVE')
      .executeTakeFirstOrThrow();

    if (Number(count) <= 1) {
      throw new HttpException(
        { error: { code: errorCode.USER_LAST_ACTIVE_ADMIN_PROTECTED, message: `Cannot ${action}: at least one active ADMIN required`, requestId: '' } },
        409,
      );
    }
  }
}
