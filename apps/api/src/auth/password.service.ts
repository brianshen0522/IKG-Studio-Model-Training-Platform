import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';

@Injectable()
export class PasswordService {
  private dummyHash?: Promise<string>;

  async hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async verify(hash: string, password: string): Promise<boolean> {
    return argon2.verify(hash, password);
  }

  /** Spends the same time as verify(), so a login for an unusable account looks like a wrong password. */
  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash(randomBytes(16).toString('hex'));
    await argon2.verify(await this.dummyHash, password);
  }

  async needsRehash(hash: string): Promise<boolean> {
    return argon2.needsRehash(hash);
  }

  /**
   * No password rules by project decision: any non-empty password is accepted, for
   * bootstrap, admin-created users and self-service changes alike. Kept as a hook so
   * callers stay unchanged if a policy is ever reintroduced.
   *
   * Returns an error message, or null when the password is acceptable.
   */
  validatePolicy(password: string, _username: string, _displayName: string): string | null {
    if (!password) return 'Password must not be empty';
    return null;
  }

  generateTemporaryPassword(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%&*';
    let password = '';
    for (let i = 0; i < 20; i++) {
      password += chars[randomBytes(1)[0] % chars.length];
    }
    return password;
  }
}
