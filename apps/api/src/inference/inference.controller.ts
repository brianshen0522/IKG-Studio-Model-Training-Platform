import { Controller, Get, Post, Param, Body, Query, Req, HttpCode, HttpException } from '@nestjs/common';
import { Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { errorCode } from '@model-trainer/shared-types';
import { InferenceService } from './inference.service';

const actorOf = (req: Request) =>
  (req as unknown as Record<string, unknown>).user as { id: string; role: string };
const badRequest = (message: string) =>
  new HttpException({ error: { code: errorCode.VALIDATION_FAILED, message, requestId: '' } }, 400);
const intOr = (v: string | undefined, d: number) => Math.max(parseInt(v ?? String(d), 10) || d, 1);
// '' (auto) | 'cpu' | comma-separated GPU indices, as for benchmark runs.
const DEVICE_RE = /^$|^cpu$|^\d+(,\d+)*$/;
// Checked here because Postgres rejects a malformed uuid with an error that
// would otherwise surface as a 500.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () =>
  new HttpException({ error: { code: errorCode.INFERENCE_RUN_NOT_FOUND, message: 'inference run not found', requestId: '' } }, 404);

@Roles('ADMIN', 'USER')
@Controller('inference-runs')
export class InferenceController {
  constructor(private readonly service: InferenceService) {}

  @Post()
  @HttpCode(202)
  create(
    @Body() body: { name?: string; description?: string | null; model_id?: string; source_dataset_ids?: string[]; device?: string } = {},
    @Req() req: Request,
  ) {
    if (!body.name || !body.model_id || !Array.isArray(body.source_dataset_ids) || !body.source_dataset_ids.length) {
      throw badRequest('name, model_id, source_dataset_ids are required');
    }
    const ids = [body.model_id, ...body.source_dataset_ids];
    if (!ids.every((v) => typeof v === 'string' && UUID_RE.test(v))) {
      throw badRequest('model_id and source_dataset_ids must be UUIDs');
    }
    const device = body.device ?? '';
    if (!DEVICE_RE.test(device)) {
      throw badRequest("device must be '', 'cpu', or comma-separated GPU indices");
    }
    return this.service.create({
      name: body.name, description: body.description, model_id: body.model_id,
      source_dataset_ids: body.source_dataset_ids, device,
    }, actorOf(req));
  }

  @Get()
  async list(
    @Query('page') page?: string, @Query('size') size?: string,
    @Query('status') status?: string, @Query('dataset_type_id') datasetTypeId?: string,
  ) {
    if (datasetTypeId && !UUID_RE.test(datasetTypeId)) throw badRequest('dataset_type_id must be a UUID');
    const result = await this.service.list({ page: intOr(page, 1), size: intOr(size, 25), status, datasetTypeId });
    return {
      data: result.items,
      meta: { page: result.page, size: result.size, total: result.total, totalPages: Math.ceil(result.total / result.size) },
    };
  }

  @Get(':id')
  get(@Param('id') id: string) {
    if (!UUID_RE.test(id)) throw notFound();
    return this.service.get(id);
  }
}
