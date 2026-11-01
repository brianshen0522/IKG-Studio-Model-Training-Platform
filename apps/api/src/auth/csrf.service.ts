import { Inject, Injectable } from '@nestjs/common';
import { ENV_PROVIDER } from '../config/config.module';
import type { Env } from '../config/config.schema';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

const CSRF_COOKIE = 'csrf-token';
const CSRF_HEADER = 'x-csrf-token';

@Injectable()
export class CsrfService {
  // No built-in fallback value: a secret that ships in the source signs nothing. Without
  // either variable a per-process key is used, which only costs a re-login after restart.
  private readonly secret: string;

  constructor(@Inject(ENV_PROVIDER) env: Env) {
    this.secret = env.CSRF_SECRET || env.SESSION_SECRET || randomBytes(32).toString('hex');
  }

  /** Covers the session too, so a token issued to one account is no use in another's. */
  private sign(nonce: string, sessionToken: string): string {
    return createHmac('sha256', this.secret).update(`${sessionToken}.${nonce}`).digest('hex');
  }

  generateToken(sessionToken: string): string {
    const nonce = randomBytes(16).toString('hex');
    return `${nonce}.${this.sign(nonce, sessionToken)}`;
  }

  validateToken(token: string, sessionToken: string): boolean {
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [nonce, hmac] = parts;
    const expected = Buffer.from(this.sign(nonce, sessionToken));
    const actual = Buffer.from(hmac);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  cookieName(): string {
    return CSRF_COOKIE;
  }

  headerName(): string {
    return CSRF_HEADER;
  }
}
