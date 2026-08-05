import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { AuditModule } from '../../audit/audit.module';
import { OutboxModule } from '../../outbox/outbox.module';
import { DatasetTypesController } from './dataset-types.controller';
import { DatasetTypesOptionsController } from './dataset-types-options.controller';
import { DatasetTypesService } from './dataset-types.service';
import { DatasetTypesTreeService } from './dataset-types-tree.service';
import { DatasetTypesValidatorService } from './dataset-types-validator.service';
import { BrowsePathController } from './browse-path.controller';

@Module({
  imports: [AuthModule, AuditModule, OutboxModule],
  controllers: [DatasetTypesController, DatasetTypesOptionsController, BrowsePathController],
  providers: [DatasetTypesService, DatasetTypesTreeService, DatasetTypesValidatorService],
})
export class DatasetTypesModule {}
