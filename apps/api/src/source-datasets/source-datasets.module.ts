import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { OutboxModule } from '../outbox/outbox.module';
import { DatasetTypesTreeService } from '../admin/dataset-types/dataset-types-tree.service';
import { SourceDatasetsController } from './source-datasets.controller';
import { SourceDatasetsService } from './source-datasets.service';

@Module({
  imports: [AuthModule, AuditModule, OutboxModule],
  controllers: [SourceDatasetsController],
  providers: [SourceDatasetsService, DatasetTypesTreeService],
})
export class SourceDatasetsModule {}
