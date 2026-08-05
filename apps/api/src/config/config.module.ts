import { Global, Module } from '@nestjs/common';
import { loadEnv } from './config.schema';

export const ENV_PROVIDER = 'ENV';

@Global()
@Module({
  providers: [
    {
      provide: ENV_PROVIDER,
      useFactory: () => loadEnv(),
    },
  ],
  exports: [ENV_PROVIDER],
})
export class ConfigModule {}
