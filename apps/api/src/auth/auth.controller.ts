import {
  Controller, Post, Get, Delete, Param, Body, Req, Res, Inject,
  HttpException, HttpCode, UseGuards,
} from '@nestjs/common';
import { AuthRateLimitGuard } from '../common/rate-limit/auth-rate-limit.guard';
import { DB_PROVIDER } from '../database/database.module';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { Database } from '@model-trainer/db';
import type { Response, Request } from 'express';
import { Public } from './decorators/public.decorator';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { SystemSettingsService } from './system-settings.service';
import { AuditService } from '../audit/audit.service';
import { CsrfService } from './csrf.service';
import { errorCode } from '@model-trainer/shared-types';
import { ROLE_PERMISSIONS } from './permission.map';

// Whether auth cookies carry the Secure attribute. Secure cookies are dropped by
// browsers over plain HTTP, so an HTTP deployment (or one behind a TLS-terminating
// proxy that forwards HTTP) must set COOKIE_SECURE=false. Defaults to the NODE_ENV
// behaviour when the variable is unset.
const COOKIE_SECURE =
  process.env.COOKIE_SECURE !== undefined
    ? process.env.COOKIE_SECURE === 'true'
    : process.env.NODE_ENV === 'production';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(DB_PROVIDER) private readonly db: Kysely<Database>,
    private readonly passwordService: PasswordService,
    private readonly sessionService: SessionService,
    private readonly settings: SystemSettingsService,
    private readonly auditService: AuditService,
    private readonly csrfService: CsrfService,
  ) {}

  @Public()
  @UseGuards(AuthRateLimitGuard)
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: { username?: string; password?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { username, password } = body ?? {};

    if (!username || !password) {
      throw new HttpException(
        { error: { code: errorCode.AUTH_INVALID_CREDENTIALS, message: 'Invalid credentials', requestId: '' } },
        401,
      );
    }

    const normalizedUsername = username.trim().toLowerCase();
    const ip = req.ip ?? req.socket?.remoteAddress ?? null;
    const ua = req.headers['user-agent'] ?? null;

    const user = await this.db
      .selectFrom('users')
      .selectAll()
      .where(sql`LOWER(username)`, '=', normalizedUsername)
      .executeTakeFirst();

    if (!user) {
      await this.auditService.append({
        actorType: 'SYSTEM',
        actorRef: 'login',
        actionCode: 'AUTH_LOGIN_FAILED',
        resourceTypeCode: 'USER',
        resourceId: '00000000-0000-0000-0000-000000000000',
        result: 'FAILURE',
        metadata: { submitted_username: normalizedUsername, failure_reason: 'USER_NOT_FOUND' },
        errorCode: errorCode.AUTH_INVALID_CREDENTIALS,
        ipAddress: ip,
        userAgent: ua,
      });
      throw new HttpException(
        { error: { code: errorCode.AUTH_INVALID_CREDENTIALS, message: 'Invalid credentials', requestId: '' } },
        401,
      );
    }

    if (user.status === 'LOCKED' && user.locked_until) {
      const lockedUntil = new Date(user.locked_until);
      if (lockedUntil <= new Date()) {
        await this.db
          .updateTable('users')
          .set({ status: 'ACTIVE', failed_login_count: 0, locked_until: null, updated_at: sql`now()` })
          .where('id', '=', user.id)
          .where('status', '=', 'LOCKED')
          .execute();

        await this.auditService.append({
          actorType: 'SYSTEM',
          actorRef: 'auto-unlock',
          actionCode: 'AUTH_ACCOUNT_AUTO_UNLOCKED',
          resourceTypeCode: 'USER',
          resourceId: user.id,
          result: 'SUCCESS',
          metadata: { username: user.username },
          ipAddress: ip,
          userAgent: ua,
        });
      }
    }

    const freshUser = await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', user.id)
      .executeTakeFirst();

    if (!freshUser) {
      throw new HttpException(
        { error: { code: errorCode.AUTH_INVALID_CREDENTIALS, message: 'Invalid credentials', requestId: '' } },
        401,
      );
    }

    if (freshUser.status !== 'ACTIVE') {
      await this.incrementFailedLogin(freshUser.id, ip, ua);
      await this.auditService.append({
        actorType: 'SYSTEM',
        actorRef: 'login',
        actionCode: 'AUTH_LOGIN_FAILED',
        resourceTypeCode: 'USER',
        resourceId: freshUser.id,
        result: 'FAILURE',
        metadata: { submitted_username: normalizedUsername, failure_reason: freshUser.status === 'LOCKED' ? 'ACCOUNT_LOCKED' : 'ACCOUNT_DISABLED' },
        errorCode: errorCode.AUTH_INVALID_CREDENTIALS,
        ipAddress: ip,
        userAgent: ua,
      });
      throw new HttpException(
        { error: { code: errorCode.AUTH_INVALID_CREDENTIALS, message: 'Invalid credentials', requestId: '' } },
        401,
      );
    }

    const valid = await this.passwordService.verify(freshUser.password_hash, password);
    if (!valid) {
      await this.incrementFailedLogin(freshUser.id, ip, ua);
      await this.auditService.append({
        actorType: 'SYSTEM',
        actorRef: 'login',
        actionCode: 'AUTH_LOGIN_FAILED',
        resourceTypeCode: 'USER',
        resourceId: freshUser.id,
        result: 'FAILURE',
        metadata: { submitted_username: normalizedUsername, failure_reason: 'PASSWORD_MISMATCH', failed_login_count: freshUser.failed_login_count + 1 },
        errorCode: errorCode.AUTH_INVALID_CREDENTIALS,
        ipAddress: ip,
        userAgent: ua,
      });
      throw new HttpException(
        { error: { code: errorCode.AUTH_INVALID_CREDENTIALS, message: 'Invalid credentials', requestId: '' } },
        401,
      );
    }

    if (await this.passwordService.needsRehash(freshUser.password_hash)) {
      const newHash = await this.passwordService.hash(password);
      await this.db
        .updateTable('users')
        .set({ password_hash: newHash, password_updated_at: sql`now()` })
        .where('id', '=', freshUser.id)
        .execute();
    }

    await this.db
      .updateTable('users')
      .set({ failed_login_count: 0, locked_until: null, last_login_at: sql`now()`, updated_at: sql`now()` })
      .where('id', '=', freshUser.id)
      .execute();

    const { sessionId } = await this.sessionService.create(
      freshUser.id,
      freshUser.role,
      freshUser.status,
      freshUser.must_change_password,
      freshUser.password_updated_at,
      ip,
      ua,
    );

    const csrfToken = this.csrfService.generateToken();

    res.cookie(this.sessionService.cookieName(), sessionId, {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: 'lax',
      path: '/',
    });

    res.cookie(this.csrfService.cookieName(), csrfToken, {
      httpOnly: false,
      secure: COOKIE_SECURE,
      sameSite: 'lax',
      path: '/',
    });

    await this.auditService.append({
      actorType: 'USER',
      actorUserId: freshUser.id,
      actionCode: 'AUTH_LOGIN_SUCCEEDED',
      resourceTypeCode: 'USER',
      resourceId: freshUser.id,
      result: 'SUCCESS',
      metadata: { username: freshUser.username },
      ipAddress: ip,
      userAgent: ua,
    });

    const permissions = ROLE_PERMISSIONS[freshUser.role] ?? [];

    return {
      user: {
        id: freshUser.id,
        username: freshUser.username,
        display_name: freshUser.display_name,
        email: freshUser.email,
        role: freshUser.role,
        status: freshUser.status,
        must_change_password: freshUser.must_change_password,
        last_login_at: freshUser.last_login_at,
        permissions,
      },
      csrfToken,
    };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = this.sessionService.extractToken(req);
    if (token) {
      const user = (req as unknown as Record<string, unknown>).user as { id: string } | undefined;
      await this.sessionService.revoke(token, 'USER_LOGOUT');
      if (user?.id) {
        await this.auditService.append({
          actorType: 'USER',
          actorUserId: user.id,
          actionCode: 'AUTH_LOGOUT',
          resourceTypeCode: 'USER',
          resourceId: user.id,
          result: 'SUCCESS',
        });
      }
    }

    res.clearCookie(this.sessionService.cookieName(), { path: '/' });
    res.clearCookie(this.csrfService.cookieName(), { path: '/' });
    return { message: 'Logged out' };
  }

  @Post('logout-all')
  @HttpCode(200)
  async logoutAll(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = this.sessionService.extractToken(req);
    const user = (req as unknown as Record<string, unknown>).user as { id: string } | undefined;

    if (user?.id) {
      await this.sessionService.revokeAllForUser(user.id, token ?? undefined);
      await this.auditService.append({
        actorType: 'USER',
        actorUserId: user.id,
        actionCode: 'AUTH_LOGOUT_ALL',
        resourceTypeCode: 'USER',
        resourceId: user.id,
        result: 'SUCCESS',
      });
    }

    res.clearCookie(this.sessionService.cookieName(), { path: '/' });
    res.clearCookie(this.csrfService.cookieName(), { path: '/' });
    return { message: 'All sessions logged out' };
  }

  @Get('me')
  async me(@Req() req: Request) {
    const user = (req as unknown as Record<string, unknown>).user as { id: string; role: string } | undefined;
    if (!user?.id) {
      throw new HttpException(
        { error: { code: errorCode.AUTH_SESSION_EXPIRED, message: 'Not authenticated', requestId: '' } },
        401,
      );
    }

    const row = await this.db
      .selectFrom('users')
      .select([
        'id', 'username', 'display_name', 'email', 'role',
        'status', 'must_change_password', 'last_login_at', 'created_at',
      ])
      .where('id', '=', user.id)
      .executeTakeFirst();

    if (!row) {
      throw new HttpException(
        { error: { code: errorCode.RESOURCE_NOT_FOUND, message: 'User not found', requestId: '' } },
        404,
      );
    }

    const permissions = ROLE_PERMISSIONS[user.role as keyof typeof ROLE_PERMISSIONS] ?? [];

    return { ...row, permissions };
  }

  @Post('change-password')
  @HttpCode(200)
  async changePassword(
    @Body() body: { current_password?: string; new_password?: string; new_password_confirmation?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = (req as unknown as Record<string, unknown>).user as { id: string } | undefined;
    if (!user?.id) {
      throw new HttpException(
        { error: { code: errorCode.AUTH_SESSION_EXPIRED, message: 'Not authenticated', requestId: '' } },
        401,
      );
    }

    const { current_password, new_password, new_password_confirmation } = body ?? {};

    if (!current_password || !new_password || !new_password_confirmation) {
      throw new HttpException(
        { error: { code: errorCode.VALIDATION_FAILED, message: 'All password fields required', requestId: '' } },
        400,
      );
    }

    if (new_password !== new_password_confirmation) {
      throw new HttpException(
        { error: { code: errorCode.VALIDATION_FAILED, message: 'New passwords do not match', requestId: '' } },
        400,
      );
    }

    const row = await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', user.id)
      .executeTakeFirst();

    if (!row) {
      throw new HttpException(
        { error: { code: errorCode.RESOURCE_NOT_FOUND, message: 'User not found', requestId: '' } },
        404,
      );
    }

    if (!(await this.passwordService.verify(row.password_hash, current_password))) {
      throw new HttpException(
        { error: { code: errorCode.AUTH_CURRENT_PASSWORD_INVALID, message: 'Current password is incorrect', requestId: '' } },
        400,
      );
    }

    if (await this.passwordService.verify(row.password_hash, new_password)) {
      throw new HttpException(
        { error: { code: errorCode.AUTH_PASSWORD_POLICY_FAILED, message: 'New password must differ from current', requestId: '' } },
        400,
      );
    }

    const policyError = this.passwordService.validatePolicy(new_password, row.username, row.display_name);
    if (policyError) {
      throw new HttpException(
        { error: { code: errorCode.AUTH_PASSWORD_POLICY_FAILED, message: policyError, requestId: '' } },
        400,
      );
    }

    const newHash = await this.passwordService.hash(new_password);

    const token = this.sessionService.extractToken(req);

    const updated = await this.db.transaction().execute(async (trx: Transaction<Database>) => {
      const u = await trx
        .updateTable('users')
        .set({
          password_hash: newHash,
          password_updated_at: sql`now()`,
          must_change_password: false,
          updated_at: sql`now()`,
        })
        .where('id', '=', user.id)
        .returning('password_updated_at')
        .executeTakeFirstOrThrow();

      await this.auditService.append({
        actorType: 'USER',
        actorUserId: user.id,
        actionCode: 'USER_PASSWORD_CHANGED',
        resourceTypeCode: 'USER',
        resourceId: user.id,
        result: 'SUCCESS',
        metadata: { username: row.username },
      }, trx);

      if (token) {
        const currentHash = this.sessionService.hashToken(token);
        // Revoke every other session; keep the current one but bump its password version.
        await trx
          .updateTable('user_sessions')
          .set({ revoked_at: sql`now()`, revoked_reason: 'PASSWORD_CHANGED' })
          .where('user_id', '=', user.id)
          .where('session_token_hash', '!=', currentHash)
          .execute();
        await trx
          .updateTable('user_sessions')
          .set({ created_password_version: u.password_updated_at })
          .where('session_token_hash', '=', currentHash)
          .execute();
      } else {
        await trx
          .updateTable('user_sessions')
          .set({ revoked_at: sql`now()`, revoked_reason: 'PASSWORD_CHANGED' })
          .where('user_id', '=', user.id)
          .execute();
      }

      return u;
    });

    if (token) {
      await this.sessionService.updateSessionPasswordVersion(token, updated.password_updated_at);
    }

    return { message: 'Password changed successfully' };
  }

  @Get('sessions')
  async listSessions(@Req() req: Request) {
    const user = (req as unknown as Record<string, unknown>).user as { id: string } | undefined;
    if (!user?.id) {
      throw new HttpException(
        { error: { code: errorCode.AUTH_SESSION_EXPIRED, message: 'Not authenticated', requestId: '' } },
        401,
      );
    }

    const sessions = await this.sessionService.getUserSessions(user.id);

    return sessions.map((s) => ({
      id: s.id,
      created_at: s.created_at,
      last_seen_at: s.last_seen_at,
      idle_expires_at: s.idle_expires_at,
      absolute_expires_at: s.absolute_expires_at,
      revoked_at: s.revoked_at,
      ip_address: s.ip_address,
      user_agent: s.user_agent,
      is_active: s.is_active,
    }));
  }

  @Delete('sessions/:sessionId')
  @HttpCode(200)
  async deleteSession(@Param('sessionId') sessionId: string, @Req() req: Request) {
    const user = (req as unknown as Record<string, unknown>).user as { id: string } | undefined;
    if (!user?.id) {
      throw new HttpException(
        { error: { code: errorCode.AUTH_SESSION_EXPIRED, message: 'Not authenticated', requestId: '' } },
        401,
      );
    }

    const token = this.sessionService.extractToken(req);
    const currentTokenHash = token ? this.sessionService.hashToken(token) : null;

    const session = await this.db
      .selectFrom('user_sessions')
      .select(['id', 'session_token_hash'])
      .where('id', '=', sessionId)
      .where('user_id', '=', user.id)
      .executeTakeFirst();

    if (!session) {
      throw new HttpException(
        { error: { code: errorCode.RESOURCE_NOT_FOUND, message: 'Session not found', requestId: '' } },
        404,
      );
    }

    if (currentTokenHash && session.session_token_hash === currentTokenHash) {
      throw new HttpException(
        { error: { code: errorCode.RESOURCE_CONFLICT, message: 'Cannot delete current session', requestId: '' } },
        409,
      );
    }

    await this.sessionService.revokeSessionById(sessionId, user.id, 'USER_REVOKED');

    await this.auditService.append({
      actorType: 'USER',
      actorUserId: user.id,
      actionCode: 'AUTH_SESSION_REVOKED',
      resourceTypeCode: 'USER',
      resourceId: user.id,
      result: 'SUCCESS',
      metadata: { session_id: sessionId },
    });

    return { message: 'Session revoked' };
  }

  private async incrementFailedLogin(userId: string, ip: string | null, ua: string | null): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('users')
        .set({ failed_login_count: sql`failed_login_count + 1`, updated_at: sql`now()` })
        .where('id', '=', userId)
        .returning(['failed_login_count', 'status'])
        .executeTakeFirst();

      if (updated) {
        const threshold = await this.settings.getFailedLoginThreshold();
        if (updated.failed_login_count >= threshold) {
          const lockoutMinutes = await this.settings.getLockoutMinutes();
          const lockedUntil = new Date(Date.now() + lockoutMinutes * 60 * 1000).toISOString();

          await trx
            .updateTable('users')
            .set({ status: 'LOCKED', locked_until: lockedUntil })
            .where('id', '=', userId)
            .where('status', '!=', 'LOCKED')
            .where('failed_login_count', '>=', threshold)
            .execute();
        }
      }
    });
  }
}
