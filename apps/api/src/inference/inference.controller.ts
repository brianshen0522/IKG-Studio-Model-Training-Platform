import { Controller, Get, Post, Param, Body, Query, Req, Res, HttpCode, HttpException } from '@nestjs/common';
import { Request, Response } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { errorCode } from '@model-trainer/shared-types';
import { InferenceService, DIFF_KINDS, type DiffKind } from './inference.service';

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

  @Post(':id/stop')
  @HttpCode(202)
  stop(@Param('id') id: string, @Req() req: Request) {
    if (!UUID_RE.test(id)) throw notFound();
    return this.service.requestStop(id, actorOf(req));
  }

  @Post(':id/retry')
  @HttpCode(202)
  retry(@Param('id') id: string, @Req() req: Request) {
    if (!UUID_RE.test(id)) throw notFound();
    return this.service.retry(id, actorOf(req));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    if (!UUID_RE.test(id)) throw notFound();
    return this.service.get(id);
  }

  @Get(':id/datasets/:rdId/diffs')
  async listDiffs(
    @Param('id') id: string, @Param('rdId') rdId: string,
    @Query('page') page?: string, @Query('size') size?: string,
    @Query('kind') kind?: string, @Query('sort') sort?: string,
  ) {
    if (!UUID_RE.test(id) || !UUID_RE.test(rdId)) throw notFound();
    if (kind && !(DIFF_KINDS as readonly string[]).includes(kind)) {
      throw badRequest(`kind must be one of ${DIFF_KINDS.join(', ')}`);
    }
    if (sort && sort !== 'path' && sort !== 'most') throw badRequest("sort must be 'path' or 'most'");
    const r = await this.service.listDiffs(id, rdId, {
      page: intOr(page, 1), size: intOr(size, 100), kind: kind as DiffKind | undefined, sort: sort === 'most' ? 'most' : 'path',
    });
    return {
      data: r.items,
      meta: { page: r.page, size: r.size, total: r.total, totalPages: Math.ceil(r.total / r.size) },
    };
  }

  @Get(':id/datasets/:rdId')
  getRunDataset(@Param('id') id: string, @Param('rdId') rdId: string) {
    if (!UUID_RE.test(id) || !UUID_RE.test(rdId)) throw notFound();
    return this.service.getRunDataset(id, rdId);
  }

  @Get(':id/datasets/:rdId/diffs/:diffId')
  getDiff(@Param('id') id: string, @Param('rdId') rdId: string, @Param('diffId') diffId: string) {
    if (![id, rdId, diffId].every((v) => UUID_RE.test(v))) throw notFound();
    return this.service.getDiff(id, rdId, diffId);
  }

  @Get(':id/datasets/:rdId/diffs/:diffId/image')
  async getDiffImage(
    @Param('id') id: string, @Param('rdId') rdId: string, @Param('diffId') diffId: string,
    @Res() res: Response,
  ) {
    if (![id, rdId, diffId].every((v) => UUID_RE.test(v))) throw notFound();
    const full = await this.service.diffImagePath(id, rdId, diffId);
    // Diff rows never change, but the file behind one can (Dataset Manager
    // re-archives into the same folder), so let the browser revalidate.
    res.sendFile(full, { headers: { 'Cache-Control': 'private, no-cache' } });
  }
}
