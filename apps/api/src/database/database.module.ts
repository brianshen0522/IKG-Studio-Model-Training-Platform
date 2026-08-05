import { Global, Module, Inject, OnModuleDestroy } from '@nestjs/common';
import { ENV_PROVIDER } from '../config/config.module';
import { createDb, DbInstance } from '@model-trainer/db';
import type { Env } from '../config/config.schema';

export const DB_INSTANCE = 'DB_INSTANCE';
export const DB_PROVIDER = 'DB';

@Global()
@Module({
  providers: [
    {
      provide: DB_INSTANCE,
      inject: [ENV_PROVIDER],
      useFactory: (env: Env): DbInstance => {
        return createDb({
          host: env.POSTGRES_HOST,
          port: env.POSTGRES_PORT,
          database: env.POSTGRES_DB,
          user: env.POSTGRES_USER,
          password: env.POSTGRES_PASSWORD,
        });
      },
    },
    {
      provide: DB_PROVIDER,
      inject: [DB_INSTANCE],
      useFactory: (instance: DbInstance) => instance.db,
    },
  ],
  exports: [DB_PROVIDER],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(DB_INSTANCE) private dbInstance: DbInstance) {}
  async onModuleDestroy() {
    await this.dbInstance.pool.end();
  }
}
