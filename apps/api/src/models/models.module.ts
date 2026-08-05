import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ModelsController } from './models.controller';
import { ModelsService } from './models.service';
import { ModelConversionsController } from './conversions.controller';
import { ModelConversionsService } from './conversions.service';

@Module({
  imports: [AuthModule, AuditModule, OutboxModule],
  controllers: [ModelsController, ModelConversionsController],
  providers: [ModelsService, ModelConversionsService],
})
export class ModelsModule {}
