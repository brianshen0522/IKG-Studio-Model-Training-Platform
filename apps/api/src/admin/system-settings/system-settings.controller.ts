import { Controller, Get, Patch, Param, Body, Req, HttpException } from '@nestjs/common';
import { Request } from 'express';
import { Roles } from '../../auth/decorators/roles.decorator';
import { errorCode } from '@model-trainer/shared-types';
import { SystemSettingsService } from './system-settings.service';

const actorOf = (req: Request) =>
  (req as unknown as Record<string, unknown>).user as { id: string; role: string };

const badRequest = (message: string) =>
  new HttpException({ error: { code: errorCode.VALIDATION_FAILED, message, requestId: '' } }, 400);

@Roles('ADMIN')
@Controller('admin/system-settings')
export class SystemSettingsController {
  constructor(private readonly service: SystemSettingsService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Patch(':key')
  async update(
    @Param('key') key: string,
    @Body() body: { value?: unknown } = {},
    @Req() req: Request,
  ) {
    if (body.value === undefined) throw badRequest('value is required');
    return this.service.update(key, body.value, actorOf(req).id);
  }
}
