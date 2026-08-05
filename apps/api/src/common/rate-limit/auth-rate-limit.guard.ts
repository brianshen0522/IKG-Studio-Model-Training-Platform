import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { errorCode } from '@model-trainer/shared-types';
import { RateLimitService, type ConsumeResult } from './rate-limit.service';

const num = (v: string | undefined, d: number): number => Number(v ?? d) || d;

// Login rate limits (doc 04 §35 / 17 §14): by IP, by username, and by IP+username.
const WINDOW_S = num(process.env.RL_LOGIN_WINDOW_S, 300);
const IP_LIMIT = num(process.env.RL_LOGIN_IP, 30);
const USER_LIMIT = num(process.env.RL_LOGIN_USER, 10);
const IP_USER_LIMIT = num(process.env.RL_LOGIN_IP_USER, 8);

/**
 * Throttles login attempts (password + passkey). Applied per-endpoint via @UseGuards.
 * Counts every attempt (success or failure) so brute-force is capped before auth runs.
 */
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  constructor(private readonly rl: RateLimitService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const res = ctx.switchToHttp().getResponse();
    const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const username = String(req.body?.username ?? '').trim().toLowerCase() || null;

    const checks: Array<Promise<ConsumeResult>> = [
      this.rl.consume(`login:ip:${ip}`, IP_LIMIT, WINDOW_S),
    ];
    if (username) {
      checks.push(this.rl.consume(`login:user:${username}`, USER_LIMIT, WINDOW_S));
      checks.push(this.rl.consume(`login:ipuser:${ip}:${username}`, IP_USER_LIMIT, WINDOW_S));
    }

    const blocked = (await Promise.all(checks)).filter((r) => !r.allowed);
    if (blocked.length > 0) {
      const retryAfter = Math.max(1, ...blocked.map((r) => r.retryAfterS));
      res.setHeader('Retry-After', String(retryAfter));
      throw new HttpException(
        {
          error: {
            code: errorCode.RATE_LIMITED,
            message: 'Too many login attempts; please try again later',
            requestId: '',
          },
        },
        429,
      );
    }
    return true;
  }
}
