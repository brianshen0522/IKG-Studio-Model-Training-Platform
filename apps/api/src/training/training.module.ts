import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { OutboxModule } from '../outbox/outbox.module';
import { TrainingController } from './training.controller';
import { TrainingService } from './training.service';
import { TrainingStateMachine } from './training-state-machine';

@Module({
  imports: [AuthModule, AuditModule, OutboxModule],
  controllers: [TrainingController],
  providers: [TrainingService, TrainingStateMachine],
})
export class TrainingModule {}
