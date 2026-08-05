import { Inject, Injectable } from '@nestjs/common';
import { DB_PROVIDER } from '../database/database.module';
import { REDIS_PROVIDER } from '../redis/redis.module';
import { SystemSettingsService } from './system-settings.service';
import { type Kysely, sql, type Transaction, type Selectable } from 'kysely';
import type { Database, UserSessionsTable } from '@model-trainer/db';
import type { Redis } from 'ioredis';
import { randomBytes, createHash } from 'crypto';

const SESSION_COOKIE = 'sid';
const REDIS_PREFIX = 'session:';

export interface SessionData {
  sessionId: string;
  userId: string;
  role: string;
  status: string;
  mustChangePassword: boolean;
  passwordUpdatedAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}

@Injectable()
export class SessionService {
  constructor(
    @Inject(DB_PROVIDER) private readonly db: Kysely<Database>,
    @Inject(REDIS_PROVIDER) private readonly redis: Redis,
    private readonly settings: SystemSettingsService,
  ) {}

  generateSessionId(): string {
    return randomBytes(32).toString('hex');
  }

  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  cookieName(): string {
    return SESSION_COOKIE;
  }

  async create(
    userId: string,
    role: string,
    status: string,
    mustChangePassword: boolean,
    passwordUpdatedAt: string,
    ipAddress: string | null,
    userAgent: string | null,
  ): Promise<{ sessionId: string; idleExpiresAt: Date; absoluteExpiresAt: Date }> {
    const sessionId = this.generateSessionId();
    const tokenHash = this.hashToken(sessionId);
    const idleMinutes = await this.settings.getSessionIdleMinutes();
    const absoluteHours = await this.settings.getSessionAbsoluteHours();
    const now = new Date();
    const idleExpiresAt = new Date(now.getTime() + idleMinutes * 60 * 1000);
    const absoluteExpiresAt = new Date(now.getTime() + absoluteHours * 60 * 60 * 1000);

    await this.db
      .insertInto('user_sessions')
      .values({
        user_id: userId,
        session_token_hash: tokenHash,
        idle_expires_at: idleExpiresAt.toISOString(),
        absolute_expires_at: absoluteExpiresAt.toISOString(),
        created_password_version: passwordUpdatedAt,
        ip_address: ipAddress,
        user_agent: userAgent,
      })
      .execute();

    const redisKey = REDIS_PREFIX + tokenHash;
    await this.redis.setex(
      redisKey,
      absoluteHours * 3600,
      JSON.stringify({
        sessionId,
        userId,
        role,
        status,
        mustChangePassword,
        passwordUpdatedAt,
        idleExpiresAt: idleExpiresAt.toISOString(),
        absoluteExpiresAt: absoluteExpiresAt.toISOString(),
      }),
    );

    return { sessionId, idleExpiresAt, absoluteExpiresAt };
  }

  async validate(token: string): Promise<SessionData | null> {
    const tokenHash = this.hashToken(token);
    const redisKey = REDIS_PREFIX + tokenHash;

    const cached = await this.redis.get(redisKey);
    let data: SessionData | null = null;

    if (cached) {
      data = JSON.parse(cached) as SessionData;
    } else {
      const session = await this.db
        .selectFrom('user_sessions')
        .selectAll()
        .where('session_token_hash', '=', tokenHash)
        .executeTakeFirst();

      if (!session) return null;

      const user = await this.db
        .selectFrom('users')
        .select(['id', 'role', 'status', 'password_updated_at', 'must_change_password'])
        .where('id', '=', session.user_id)
        .executeTakeFirst();

      if (!user) return null;

      data = {
        sessionId: token,
        userId: user.id,
        role: user.role,
        status: user.status,
        mustChangePassword: user.must_change_password,
        passwordUpdatedAt: user.password_updated_at,
        idleExpiresAt: session.idle_expires_at,
        absoluteExpiresAt: session.absolute_expires_at,
      };
    }

    if (!data) return null;

    const now = new Date();

    if (new Date(data.absoluteExpiresAt) <= now) return null;

    if (new Date(data.idleExpiresAt) <= now) return null;

    const user = await this.db
      .selectFrom('users')
      .select(['id', 'role', 'status', 'password_updated_at', 'must_change_password'])
      .where('id', '=', data.userId)
      .executeTakeFirst();

    if (!user) return null;
    if (user.status !== 'ACTIVE') return null;
    if (user.password_updated_at !== data.passwordUpdatedAt) return null;

    const session = await this.db
      .selectFrom('user_sessions')
      .select('revoked_at')
      .where('session_token_hash', '=', tokenHash)
      .executeTakeFirst();

    if (!session || session.revoked_at) return null;

    const idleMinutes = await this.settings.getSessionIdleMinutes();
    const newIdleExpiresAt = new Date(now.getTime() + idleMinutes * 60 * 1000);

    await this.db
      .updateTable('user_sessions')
      .set({ last_seen_at: now.toISOString(), idle_expires_at: newIdleExpiresAt.toISOString() })
      .where('session_token_hash', '=', tokenHash)
      .execute();

    data.idleExpiresAt = newIdleExpiresAt.toISOString();
    data.role = user.role;
    data.status = user.status;
    data.mustChangePassword = user.must_change_password;

    const absoluteHours = await this.settings.getSessionAbsoluteHours();
    await this.redis.setex(redisKey, absoluteHours * 3600, JSON.stringify(data));

    return data;
  }

  async revoke(token: string, reason?: string): Promise<void> {
    const tokenHash = this.hashToken(token);
    const redisKey = REDIS_PREFIX + tokenHash;
    await Promise.all([
      this.db
        .updateTable('user_sessions')
        .set({ revoked_at: sql`now()`, revoked_reason: reason ?? null })
        .where('session_token_hash', '=', tokenHash)
        .execute(),
      this.redis.del(redisKey),
    ]);
  }

  async revokeAllForUser(userId: string, exceptToken?: string): Promise<number> {
    const exceptHash = exceptToken ? this.hashToken(exceptToken) : null;

    const result = await this.db
      .updateTable('user_sessions')
      .set({ revoked_at: sql`now()`, revoked_reason: 'USER_LOGOUT_ALL' })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .$if(!!exceptHash, (qb) => qb.where('session_token_hash', '!=', exceptHash!))
      .executeTakeFirst();

    return Number(result.numUpdatedRows ?? 0);
  }

  async updateSessionPasswordVersion(token: string, passwordUpdatedAt: string): Promise<void> {
    const tokenHash = this.hashToken(token);
    const redisKey = REDIS_PREFIX + tokenHash;
    const cached = await this.redis.get(redisKey);
    if (cached) {
      const data = JSON.parse(cached) as SessionData;
      data.passwordUpdatedAt = passwordUpdatedAt;
      const absoluteHours = await this.settings.getSessionAbsoluteHours();
      await this.redis.setex(redisKey, absoluteHours * 3600, JSON.stringify(data));
    }
  }

  async getUserSessions(userId: string): Promise<(Selectable<UserSessionsTable> & { is_active: boolean })[]> {
    const rows = await this.db
      .selectFrom('user_sessions')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .execute();

    const now = new Date();
    return rows.map((r) => ({
      ...r,
      is_active: !r.revoked_at && new Date(r.absolute_expires_at) > now && new Date(r.idle_expires_at) > now,
    }));
  }

  async revokeSessionById(sessionId: string, userId: string, reason?: string): Promise<boolean> {
    const session = await this.db
      .selectFrom('user_sessions')
      .select('session_token_hash')
      .where('id', '=', sessionId)
      .where('user_id', '=', userId)
      .executeTakeFirst();

    if (!session) return false;

    const redisKey = REDIS_PREFIX + session.session_token_hash;
    await Promise.all([
      this.db
        .updateTable('user_sessions')
        .set({ revoked_at: sql`now()`, revoked_reason: reason ?? null })
        .where('id', '=', sessionId)
        .execute(),
      this.redis.del(redisKey),
    ]);

    return true;
  }

  extractToken(req: { cookies?: Record<string, string>; headers?: Record<string, string | string[] | undefined> }): string | null {
    return req.cookies?.[SESSION_COOKIE] ?? null;
  }
}
