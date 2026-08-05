import { Global, Module, Inject, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ENV_PROVIDER } from '../config/config.module';
import type { Env } from '../config/config.schema';

export const REDIS_PROVIDER = 'REDIS';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_PROVIDER,
      inject: [ENV_PROVIDER],
      useFactory: (env: Env) => {
        return new Redis(env.REDIS_URL);
      },
    },
  ],
  exports: [REDIS_PROVIDER],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_PROVIDER) private redis: Redis) {}
  async onModuleDestroy() {
    await this.redis.quit();
  }
}
