import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { OutboxModule } from '../outbox/outbox.module';
import { TrainingDatasetsController } from './training-datasets.controller';
import { TrainingDatasetsService } from './training-datasets.service';

@Module({
  imports: [AuthModule, AuditModule, OutboxModule],
  controllers: [TrainingDatasetsController],
  providers: [TrainingDatasetsService],
})
export class TrainingDatasetsModule {}
