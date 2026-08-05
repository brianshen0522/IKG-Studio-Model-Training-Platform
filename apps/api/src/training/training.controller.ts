import { Controller, Get, Post, Param, Body, Query, Req, HttpCode, HttpException } from '@nestjs/common';
import { Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { errorCode } from '@model-trainer/shared-types';
import { TrainingService } from './training.service';
import { AdminAuditService } from '../audit/admin-audit.service';

const actorOf = (req: Request) =>
  (req as unknown as Record<string, unknown>).user as { id: string; role: string };
const badRequest = (message: string) =>
  new HttpException({ error: { code: errorCode.VALIDATION_FAILED, message, requestId: '' } }, 400);
const intOr = (v: string | undefined, d: number) => Math.max(parseInt(v ?? String(d), 10) || d, 1);

@Roles('ADMIN', 'USER')
@Controller('training-jobs')
export class TrainingController {
  constructor(
    private readonly service: TrainingService,
    private readonly adminAudit: AdminAuditService,
  ) {}

  @Post()
  @HttpCode(202)
  create(
    @Body() body: { name?: string; description?: string | null; training_dataset_id?: string; base_model_id?: string; hyperparameters?: Record<string, unknown>; depends_on_job_ids?: string[] } = {},
    @Req() req: Request,
  ) {
    if (!body.name || !body.training_dataset_id) {
      throw badRequest('name and training_dataset_id are required');
    }
    return this.service.create({
      name: body.name, description: body.description,
      training_dataset_id: body.training_dataset_id, base_model_id: body.base_model_id,
      hyperparameters: body.hyperparameters, depends_on_job_ids: body.depends_on_job_ids,
    }, actorOf(req));
  }

  @Get()
  async list(
    @Query('page') page?: string, @Query('size') size?: string,
    @Query('status') status?: string, @Query('training_dataset_id') datasetId?: string,
  ) {
    const result = await this.service.list({ page: intOr(page, 1), size: intOr(size, 25), status, training_dataset_id: datasetId });
    return {
      data: result.items,
      meta: { page: result.page, size: result.size, total: result.total, totalPages: Math.ceil(result.total / result.size) },
    };
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Get(':id/history')
  async history(@Param('id') id: string) {
    const items = await this.adminAudit.historyForResource('TRAINING_JOB', id);
    return { data: items };
  }

  @Post(':id/clone')
  @HttpCode(202)
  clone(@Param('id') id: string, @Req() req: Request) {
    return this.service.clone(id, actorOf(req));
  }

  @Post(':id/retry')
  @HttpCode(202)
  retry(@Param('id') id: string, @Req() req: Request) {
    return this.service.retry(id, actorOf(req));
  }

  @Post(':id/stop')
  @HttpCode(202)
  stop(@Param('id') id: string, @Req() req: Request) {
    return this.service.requestStop(id, actorOf(req));
  }
}
