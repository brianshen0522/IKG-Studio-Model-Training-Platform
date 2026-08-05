import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'kysely';
import { DB_PROVIDER } from '../database/database.module';
import { REDIS_PROVIDER } from '../redis/redis.module';
import { type Kysely } from 'kysely';
import type { Database } from '@model-trainer/db';
import type { Redis } from 'ioredis';
import { Public } from '../auth/decorators/public.decorator';

@Controller()
export class HealthController {
  constructor(
    @Inject(DB_PROVIDER) private db: Kysely<Database>,
    @Inject(REDIS_PROVIDER) private redis: Redis,
  ) {}

  @Public()
  @Get('/health/live')
  live() {
    return { status: 'ok' };
  }

  @Public()
  @Get('/health/ready')
  async ready() {
    const failures: string[] = [];

    try {
      await sql`SELECT 1`.execute(this.db);
    } catch {
      failures.push('postgres');
    }

    try {
      const pong = await this.redis.ping();
      if (pong !== 'PONG') failures.push('redis');
    } catch {
      failures.push('redis');
    }

    if (failures.length > 0) {
      throw new ServiceUnavailableException(`Dependencies unavailable: ${failures.join(', ')}`);
    }

    return { status: 'ok' };
  }
}
