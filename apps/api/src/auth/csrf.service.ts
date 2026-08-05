import { Inject, Injectable } from '@nestjs/common';
import { ENV_PROVIDER } from '../config/config.module';
import type { Env } from '../config/config.schema';
import { createHmac, randomBytes } from 'crypto';

const CSRF_COOKIE = 'csrf-token';
const CSRF_HEADER = 'x-csrf-token';

@Injectable()
export class CsrfService {
  constructor(@Inject(ENV_PROVIDER) private readonly env: Env) {}

  generateToken(): string {
    const nonce = randomBytes(16).toString('hex');
    const hmac = createHmac('sha256', this.env.CSRF_SECRET).update(nonce).digest('hex');
    return `${nonce}.${hmac}`;
  }

  validateToken(token: string): boolean {
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [nonce, hmac] = parts;
    const expected = createHmac('sha256', this.env.CSRF_SECRET).update(nonce).digest('hex');
    if (hmac.length !== expected.length) return false;
    return createHmac('sha256', this.env.CSRF_SECRET).update(nonce).digest('hex') === hmac;
  }

  cookieName(): string {
    return CSRF_COOKIE;
  }

  headerName(): string {
    return CSRF_HEADER;
  }
}
