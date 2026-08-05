import { Inject, Injectable, HttpException } from '@nestjs/common';
import { DB_PROVIDER } from '../database/database.module';
import { type Kysely, sql } from 'kysely';
import type { Database } from '@model-trainer/db';
import { errorCode } from '@model-trainer/shared-types';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { SessionService } from './session.service';
import { AuditService } from '../audit/audit.service';

const err = (code: string, message: string, status: number) =>
  new HttpException({ error: { code, message, requestId: '' } }, status);

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const b64u = (u: Uint8Array) => Buffer.from(u).toString('base64url');
const fromB64u = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));

export interface PasskeyUser {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  role: string;
  status: string;
  must_change_password: boolean;
  last_login_at: string | null;
  password_updated_at: string | null;
}

@Injectable()
export class WebAuthnService {
  constructor(
    @Inject(DB_PROVIDER) private readonly db: Kysely<Database>,
    private readonly sessionService: SessionService,
    private readonly auditService: AuditService,
  ) {}

  private rpID() { return process.env.WEBAUTHN_RP_ID ?? 'localhost'; }
  private rpName() { return process.env.WEBAUTHN_RP_NAME ?? 'Model Training Platform'; }
  private origin() { return process.env.WEBAUTHN_ORIGIN ?? 'http://localhost:8088'; }

  private async storeChallenge(challenge: string, flow: 'REGISTER' | 'AUTHENTICATE', userId: string | null): Promise<string> {
    const { id } = await this.db.insertInto('webauthn_challenges').values({
      challenge, flow_type: flow, user_id: userId,
      expires_at: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
    }).returning('id').executeTakeFirstOrThrow();
    return id;
  }

  private async takeChallenge(id: string, flow: 'REGISTER' | 'AUTHENTICATE') {
    const row = await this.db.selectFrom('webauthn_challenges').selectAll()
      .where('id', '=', id).where('flow_type', '=', flow).executeTakeFirst();
    if (row) await this.db.deleteFrom('webauthn_challenges').where('id', '=', id).execute();
    if (!row || new Date(row.expires_at).getTime() < Date.now()) {
      throw err(errorCode.PASSKEY_CHALLENGE_EXPIRED, 'passkey challenge expired or not found', 400);
    }
    return row;
  }

  // ── Registration (authenticated) ────────────────────────────────────────────
  async registerOptions(userId: string) {
    const user = await this.db.selectFrom('users').select(['id', 'username', 'display_name'])
      .where('id', '=', userId).executeTakeFirst();
    if (!user) throw err(errorCode.PASSKEY_REGISTRATION_FAILED, 'user not found', 404);
    const existing = await this.db.selectFrom('webauthn_credentials')
      .select(['credential_id', 'transports']).where('user_id', '=', user.id).execute();
    const options = await generateRegistrationOptions({
      rpName: this.rpName(), rpID: this.rpID(),
      userID: fromB64u(Buffer.from(user.id).toString('base64url')),
      userName: user.username, userDisplayName: user.display_name,
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: (c.transports as AuthenticatorTransportFuture[]) ?? undefined })),
      // Require a discoverable (resident) credential so users can sign in without
      // typing a username (true passwordless).
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    const challengeId = await this.storeChallenge(options.challenge, 'REGISTER', user.id);
    return { options, challengeId };
  }

  async registerVerify(userId: string, challengeId: string, response: RegistrationResponseJSON, name: string, correlationId: string) {
    const chal = await this.takeChallenge(challengeId, 'REGISTER');
    if (chal.user_id !== userId) throw err(errorCode.PASSKEY_REGISTRATION_FAILED, 'challenge does not belong to user', 400);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response, expectedChallenge: chal.challenge, expectedOrigin: this.origin(),
        expectedRPID: this.rpID(), requireUserVerification: false,
      });
    } catch (e) {
      throw err(errorCode.PASSKEY_REGISTRATION_FAILED, e instanceof Error ? e.message : 'verification failed', 400);
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw err(errorCode.PASSKEY_REGISTRATION_FAILED, 'registration not verified', 400);
    }
    const info = verification.registrationInfo;
    const label = (name ?? '').trim() || 'Passkey';
    await this.db.insertInto('webauthn_credentials').values({
      user_id: userId,
      credential_id: info.credential.id,
      public_key: b64u(info.credential.publicKey),
      counter: info.credential.counter,
      transports: JSON.stringify(info.credential.transports ?? []),
      device_type: info.credentialDeviceType,
      backed_up: info.credentialBackedUp,
      name: label,
      aaguid: info.aaguid ?? null,
    }).execute();
    await this.auditService.append({
      actorType: 'USER', actorUserId: userId, actionCode: 'PASSKEY_REGISTERED',
      resourceTypeCode: 'USER', resourceId: userId, result: 'SUCCESS', correlationId,
      metadata: { name: label, device_type: info.credentialDeviceType },
    });
    return { registered: true };
  }

  // ── Authentication (passwordless login) ─────────────────────────────────────
  async loginOptions(username?: string) {
    let allow: { id: string; transports?: string[] }[] | undefined;
    let userId: string | null = null;
    if (username && username.trim()) {
      const u = await this.db.selectFrom('users').select('id')
        .where(sql`lower(username)`, '=', username.trim().toLowerCase()).executeTakeFirst();
      if (u) {
        userId = u.id;
        const creds = await this.db.selectFrom('webauthn_credentials')
          .select(['credential_id', 'transports']).where('user_id', '=', u.id).execute();
        allow = creds.map((c) => ({ id: c.credential_id, transports: (c.transports as AuthenticatorTransportFuture[]) ?? undefined }));
      }
    }
    const options = await generateAuthenticationOptions({
      rpID: this.rpID(),
      allowCredentials: allow as never,
      userVerification: 'preferred',
    });
    const challengeId = await this.storeChallenge(options.challenge, 'AUTHENTICATE', userId);
    return { options, challengeId };
  }

  async loginVerify(challengeId: string, response: AuthenticationResponseJSON, ip: string | null, ua: string | null, correlationId: string) {
    const chal = await this.takeChallenge(challengeId, 'AUTHENTICATE');
    const cred = await this.db.selectFrom('webauthn_credentials').selectAll()
      .where('credential_id', '=', response.id).executeTakeFirst();
    if (!cred) throw err(errorCode.PASSKEY_NO_CREDENTIAL, 'no matching passkey', 400);
    if (chal.user_id && chal.user_id !== cred.user_id) throw err(errorCode.PASSKEY_AUTH_FAILED, 'passkey/user mismatch', 400);

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response, expectedChallenge: chal.challenge, expectedOrigin: this.origin(),
        expectedRPID: this.rpID(), requireUserVerification: false,
        credential: {
          id: cred.credential_id,
          publicKey: fromB64u(cred.public_key),
          counter: Number(cred.counter),
          transports: (cred.transports as AuthenticatorTransportFuture[]) ?? undefined,
        },
      });
    } catch (e) {
      throw err(errorCode.PASSKEY_AUTH_FAILED, e instanceof Error ? e.message : 'authentication failed', 400);
    }
    if (!verification.verified) throw err(errorCode.PASSKEY_AUTH_FAILED, 'passkey not verified', 401);

    const user = await this.db.selectFrom('users')
      .select(['id', 'username', 'display_name', 'email', 'role', 'status', 'must_change_password', 'last_login_at', 'password_updated_at'])
      .where('id', '=', cred.user_id).executeTakeFirst();
    if (!user) throw err(errorCode.PASSKEY_AUTH_FAILED, 'user not found', 401);
    if (user.status !== 'ACTIVE') {
      await this.auditService.append({
        actorType: 'USER', actorUserId: user.id, actionCode: 'AUTH_LOGIN_FAILED',
        resourceTypeCode: 'USER', resourceId: user.id, result: 'FAILURE', correlationId,
        metadata: { method: 'passkey', reason: user.status }, ipAddress: ip, userAgent: ua,
      });
      throw err(errorCode.AUTH_INVALID_CREDENTIALS ?? 'AUTH_INVALID_CREDENTIALS', 'account is not active', 401);
    }

    await this.db.updateTable('webauthn_credentials')
      .set({ counter: verification.authenticationInfo.newCounter, last_used_at: sql`now()` })
      .where('id', '=', cred.id).execute();
    await this.db.updateTable('users')
      .set({ last_login_at: sql`now()`, updated_at: sql`now()` }).where('id', '=', user.id).execute();

    await this.auditService.append({
      actorType: 'USER', actorUserId: user.id, actionCode: 'AUTH_LOGIN_SUCCEEDED',
      resourceTypeCode: 'USER', resourceId: user.id, result: 'SUCCESS', correlationId,
      metadata: { username: user.username, method: 'passkey' }, ipAddress: ip, userAgent: ua,
    });

    const { sessionId } = await this.sessionService.create(
      user.id, user.role, user.status, user.must_change_password, user.password_updated_at, ip, ua,
    );
    return { user: user as PasskeyUser, sessionId };
  }

  // ── Management (authenticated, own) ─────────────────────────────────────────
  async list(userId: string) {
    return this.db.selectFrom('webauthn_credentials')
      .select(['id', 'name', 'device_type', 'backed_up', 'created_at', 'last_used_at'])
      .where('user_id', '=', userId).orderBy('created_at', 'desc').execute();
  }

  async rename(userId: string, id: string, name: string, correlationId: string) {
    const label = (name ?? '').trim();
    if (!label) throw err(errorCode.VALIDATION_FAILED, 'name is required', 400);
    const res = await this.db.updateTable('webauthn_credentials').set({ name: label })
      .where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
    if (res.numUpdatedRows === 0n) throw err(errorCode.PASSKEY_NOT_FOUND, 'passkey not found', 404);
    await this.auditService.append({
      actorType: 'USER', actorUserId: userId, actionCode: 'PASSKEY_RENAMED',
      resourceTypeCode: 'USER', resourceId: userId, result: 'SUCCESS', correlationId, metadata: { id, name: label },
    });
    return { id, name: label };
  }

  async remove(userId: string, id: string, correlationId: string) {
    const res = await this.db.deleteFrom('webauthn_credentials')
      .where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
    if (res.numDeletedRows === 0n) throw err(errorCode.PASSKEY_NOT_FOUND, 'passkey not found', 404);
    await this.auditService.append({
      actorType: 'USER', actorUserId: userId, actionCode: 'PASSKEY_REVOKED',
      resourceTypeCode: 'USER', resourceId: userId, result: 'SUCCESS', correlationId, metadata: { id },
    });
    return { id, revoked: true };
  }
}
