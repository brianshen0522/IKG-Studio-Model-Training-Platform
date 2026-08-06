import { Controller, Get, Post, Param, Body, Query, Req, HttpCode, HttpException } from '@nestjs/common';
import { Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { errorCode } from '@model-trainer/shared-types';
import { BenchmarksService } from './benchmarks.service';

const actorOf = (req: Request) =>
  (req as unknown as Record<string, unknown>).user as { id: string; role: string };
const badRequest = (message: string) =>
  new HttpException({ error: { code: errorCode.VALIDATION_FAILED, message, requestId: '' } }, 400);
const intOr = (v: string | undefined, d: number) => Math.max(parseInt(v ?? String(d), 10) || d, 1);
// '' (auto) | 'cpu' | comma-separated GPU indices. Mirrors the training wizard's device values.
const DEVICE_RE = /^$|^cpu$|^\d+(,\d+)*$/;

@Roles('ADMIN', 'USER')
@Controller('benchmark-runs')
export class BenchmarksController {
  constructor(private readonly service: BenchmarksService) {}

  @Post()
  @HttpCode(202)
  create(
    @Body() body: { name?: string; description?: string | null; model_ids?: string[]; training_dataset_ids?: string[]; device?: string } = {},
    @Req() req: Request,
  ) {
    if (!body.name || !body.model_ids?.length || !body.training_dataset_ids?.length) {
      throw badRequest('name, model_ids, training_dataset_ids are required');
    }
    const device = body.device ?? '';
    if (!DEVICE_RE.test(device)) {
      throw badRequest("device must be '', 'cpu', or comma-separated GPU indices");
    }
    return this.service.create({
      name: body.name, description: body.description, model_ids: body.model_ids,
      training_dataset_ids: body.training_dataset_ids, device,
    }, actorOf(req));
  }

  @Get()
  async list(@Query('page') page?: string, @Query('size') size?: string, @Query('status') status?: string) {
    const result = await this.service.list({ page: intOr(page, 1), size: intOr(size, 25), status });
    return {
      data: result.items,
      meta: { page: result.page, size: result.size, total: result.total, totalPages: Math.ceil(result.total / result.size) },
    };
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Post(':id/stop')
  @HttpCode(202)
  stop(@Param('id') id: string, @Req() req: Request) {
    return this.service.requestStop(id, actorOf(req));
  }

  @Post(':id/retry')
  @HttpCode(202)
  retry(@Param('id') id: string, @Req() req: Request) {
    return this.service.retry(id, actorOf(req));
  }

  @Get(':id/evaluations/:evalId')
  getEvaluation(@Param('id') id: string, @Param('evalId') evalId: string) {
    return this.service.getEvaluation(id, evalId);
  }
}
