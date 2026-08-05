import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminAuditController } from './admin-audit.controller';

@Module({
  controllers: [AdminAuditController],
  providers: [AuditService, AdminAuditService],
  exports: [AuditService, AdminAuditService],
})
export class AuditModule {}
