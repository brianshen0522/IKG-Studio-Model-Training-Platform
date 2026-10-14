import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { OutboxModule } from '../outbox/outbox.module';
import { InferenceController } from './inference.controller';
import { InferenceService } from './inference.service';

@Module({
  imports: [AuthModule, AuditModule, OutboxModule],
  controllers: [InferenceController],
  providers: [InferenceService],
})
export class InferenceModule {}
