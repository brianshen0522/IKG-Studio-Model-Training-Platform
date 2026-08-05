import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { AuditModule } from './audit/audit.module';
import { OutboxModule } from './outbox/outbox.module';
import { AuthModule } from './auth/auth.module';
import { AdminUsersModule } from './admin/users/admin-users.module';
import { DatasetTypesModule } from './admin/dataset-types/dataset-types.module';
import { SystemSettingsModule } from './admin/system-settings/system-settings.module';
import { BackupModule } from './admin/backup/backup.module';
import { AdminWorkersModule } from './admin/workers/workers.module';
import { BrowseModule } from './admin/browse/browse.module';
import { MinioModule } from './minio/minio.module';
import { ArtifactsModule } from './artifacts/artifacts.module';
import { SourceDatasetsModule } from './source-datasets/source-datasets.module';
import { TrainingDatasetsModule } from './training-datasets/training-datasets.module';
import { ModelsModule } from './models/models.module';
import { TrainingModule } from './training/training.module';
import { BenchmarksModule } from './benchmarks/benchmarks.module';
import { JobsModule } from './jobs/jobs.module';
import { NotificationsModule } from './notifications/notifications.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { EventsModule } from './events/events.module';
import { HealthController } from './health/health.controller';
import { SystemController } from './system/system.controller';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';

@Module({
  imports: [ConfigModule, DatabaseModule, RedisModule, AuditModule, OutboxModule, AuthModule, MinioModule, ArtifactsModule, AdminUsersModule, DatasetTypesModule, SystemSettingsModule, BackupModule, AdminWorkersModule, BrowseModule, SourceDatasetsModule, TrainingDatasetsModule, ModelsModule, TrainingModule, BenchmarksModule, JobsModule, NotificationsModule, DashboardModule, EventsModule],
  controllers: [HealthController, SystemController],
  providers: [
    // Idempotency first → outermost, so it captures/replays the final response envelope.
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
