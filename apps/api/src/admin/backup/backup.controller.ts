import { Controller, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { Roles } from '../../auth/decorators/roles.decorator';
import { BackupService } from './backup.service';

@Roles('ADMIN')
@Controller('admin/backup')
export class BackupController {
  constructor(private readonly service: BackupService) {}

  @Post('export')
  async export(@Req() req: Request) {
    const actor = (req as unknown as Record<string, unknown>).user as { id: string; role: string };
    return this.service.exportData(actor.id);
  }

  @Post('import')
  async import(@Req() req: Request) {
    const actor = (req as unknown as Record<string, unknown>).user as { id: string; role: string };
    const payload = (req as unknown as Record<string, unknown>).body;
    return this.service.importData(payload, actor.id);
  }
}
