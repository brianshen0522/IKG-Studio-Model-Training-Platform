import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { OutboxModule } from '../outbox/outbox.module';
import { BenchmarksController } from './benchmarks.controller';
import { BenchmarksService } from './benchmarks.service';

@Module({
  imports: [AuthModule, AuditModule, OutboxModule],
  controllers: [BenchmarksController],
  providers: [BenchmarksService],
})
export class BenchmarksModule {}
