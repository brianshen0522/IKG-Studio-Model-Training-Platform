import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { AuditModule } from '../../audit/audit.module';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [BackupController],
  providers: [BackupService],
})
export class BackupModule {}
