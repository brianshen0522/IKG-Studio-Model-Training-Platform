import { Inject, Injectable } from '@nestjs/common';
import { REDIS_PROVIDER } from '../../redis/redis.module';
import type { Redis } from 'ioredis';

export interface ConsumeResult {
  allowed: boolean;
  /** Seconds until the window resets (only meaningful when !allowed). */
  retryAfterS: number;
}

/**
 * Fixed-window request counter backed by Redis, so limits hold across API instances.
 * Each `consume` increments a per-key counter; the first hit in a window sets its TTL.
 */
@Injectable()
export class RateLimitService {
  constructor(@Inject(REDIS_PROVIDER) private readonly redis: Redis) {}

  async consume(key: string, limit: number, windowS: number): Promise<ConsumeResult> {
    const redisKey = `rl:${key}`;
    const count = await this.redis.incr(redisKey);
    if (count === 1) {
      await this.redis.expire(redisKey, windowS);
    }
    if (count > limit) {
      let ttl = await this.redis.ttl(redisKey);
      if (ttl < 0) {
        // Key had no expiry (e.g. it existed before EXPIRE landed) — repair it.
        await this.redis.expire(redisKey, windowS);
        ttl = windowS;
      }
      return { allowed: false, retryAfterS: ttl };
    }
    return { allowed: true, retryAfterS: 0 };
  }
}
