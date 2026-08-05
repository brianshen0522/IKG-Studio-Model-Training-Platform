import { Controller, Get, Post, Delete, Param, Body, Req, HttpCode, HttpException } from '@nestjs/common';
import { Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { errorCode } from '@model-trainer/shared-types';
import { ModelConversionsService } from './conversions.service';

const actorOf = (req: Request) =>
  (req as unknown as Record<string, unknown>).user as { id: string; role: string };
const badRequest = (message: string) =>
  new HttpException({ error: { code: errorCode.VALIDATION_FAILED, message, requestId: '' } }, 400);

@Roles('ADMIN', 'USER')
@Controller('models/:id/conversions')
export class ModelConversionsController {
  constructor(private readonly service: ModelConversionsService) {}

  /** Admin-triggered OpenVINO conversion of an existing AVAILABLE model. */
  @Post()
  @Roles('ADMIN')
  @HttpCode(202)
  create(
    @Param('id') modelId: string,
    @Body() body: { args?: Record<string, unknown> } = {},
    @Req() req: Request,
  ) {
    if (!modelId) throw badRequest('model id is required');
    return this.service.create(modelId, body.args, actorOf(req));
  }

  @Get()
  list(@Param('id') modelId: string) {
    return this.service.list(modelId);
  }

  @Get(':conversionId')
  get(@Param('id') modelId: string, @Param('conversionId') conversionId: string) {
    return this.service.get(modelId, conversionId);
  }

  /** Hard-deletes the conversion and its OpenVINO artifact — see ModelConversionsService.remove. */
  @Delete(':conversionId')
  @Roles('ADMIN')
  @HttpCode(204)
  remove(@Param('id') modelId: string, @Param('conversionId') conversionId: string, @Req() req: Request) {
    return this.service.remove(modelId, conversionId, actorOf(req));
  }
}
