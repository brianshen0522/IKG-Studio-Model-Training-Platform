import { Module } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';

// RedisModule is @Global, so REDIS_PROVIDER is available without importing it here.
@Module({
  providers: [RateLimitService, AuthRateLimitGuard],
  exports: [RateLimitService, AuthRateLimitGuard],
})
export class RateLimitModule {}
