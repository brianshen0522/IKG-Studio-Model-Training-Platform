import { Controller, Get, Post, Delete, Param, Body, Query, Req, Res, HttpCode, HttpException } from '@nestjs/common';
import { Request, Response } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { errorCode } from '@model-trainer/shared-types';
import type { DatasetTaskType, TrainingDatasetOrigin } from '@model-trainer/db';
import { TrainingDatasetsService } from './training-datasets.service';

const actorOf = (req: Request) =>
  (req as unknown as Record<string, unknown>).user as { id: string; role: string };
const badRequest = (message: string) =>
  new HttpException({ error: { code: errorCode.VALIDATION_FAILED, message, requestId: '' } }, 400);
const intOr = (v: string | undefined, d: number) => Math.max(parseInt(v ?? String(d), 10) || d, 1);

@Roles('ADMIN', 'USER')
@Controller('training-datasets')
export class TrainingDatasetsController {
  constructor(private readonly service: TrainingDatasetsService) {}

  @Post()
  @HttpCode(201)
  create(
    @Body() body: {
      name?: string; description?: string | null; dataset_type_id?: string;
      task_type?: DatasetTaskType; origin?: TrainingDatasetOrigin; relative_path?: string;
    } = {},
    @Req() req: Request,
  ) {
    if (!body.name || !body.dataset_type_id || !body.task_type) {
      throw badRequest('name, dataset_type_id, task_type are required');
    }
    return this.service.create({
      name: body.name, description: body.description, dataset_type_id: body.dataset_type_id,
      task_type: body.task_type, origin: body.origin, relative_path: body.relative_path,
    }, actorOf(req));
  }

  @Get()
  async list(
    @Query('page') page?: string, @Query('size') size?: string,
    @Query('dataset_type_id') datasetTypeId?: string, @Query('task_type') taskType?: string,
    @Query('origin') origin?: string, @Query('archived') archived?: string,
  ) {
    const result = await this.service.list({
      page: intOr(page, 1), size: intOr(size, 25), dataset_type_id: datasetTypeId,
      task_type: taskType, origin, archived: archived === 'true',
    });
    return {
      data: result.items,
      meta: { page: result.page, size: result.size, total: result.total, totalPages: Math.ceil(result.total / result.size) },
    };
  }

  @Get('name-available')
  nameAvailable(@Query('name') name?: string, @Query('dataset_type_id') datasetTypeId?: string) {
    if (!name || !datasetTypeId) throw badRequest('name and dataset_type_id are required');
    return this.service.nameAvailable(name, datasetTypeId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  /** What deleting this dataset would leave dangling — shown in the delete confirmation. */
  @Get(':id/associations')
  associations(@Param('id') id: string) {
    return this.service.associations(id);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @HttpCode(200)
  remove(@Param('id') id: string, @Req() req: Request) {
    return this.service.deleteDataset(id, actorOf(req));
  }

  /** origin=BUILT only — a registered dataset has no split to configure. */
  @Post(':id/build-config')
  @HttpCode(200)
  configureBuild(
    @Param('id') id: string,
    @Body() body: {
      source_dataset_ids?: string[];
      split?: { strategy?: string; train_ratio?: number; val_ratio?: number; test_ratio?: number; random_seed?: number };
      storage_mode?: string;
      class_names_override?: string[] | null;
      same_split_targets?: string[];
      same_split_warning_acknowledged?: boolean;
    } = {},
    @Req() req: Request,
  ) {
    if (!body.source_dataset_ids || body.source_dataset_ids.length === 0) throw badRequest('source_dataset_ids is required');
    if (!body.split || !body.split.strategy) throw badRequest('split.strategy is required');
    return this.service.configureBuild(id, {
      source_dataset_ids: body.source_dataset_ids,
      split: {
        strategy: body.split.strategy, train_ratio: body.split.train_ratio,
        val_ratio: body.split.val_ratio, test_ratio: body.split.test_ratio, random_seed: body.split.random_seed,
      },
      storage_mode: body.storage_mode, class_names_override: body.class_names_override,
      same_split_targets: body.same_split_targets, same_split_warning_acknowledged: body.same_split_warning_acknowledged,
    }, actorOf(req));
  }

  /** Builds a BUILT dataset, validates a REGISTERED one. */
  @Post(':id/submit')
  @HttpCode(202)
  submit(@Param('id') id: string, @Req() req: Request) {
    return this.service.submit(id, actorOf(req));
  }

  @Get(':id/sources')
  getSources(@Param('id') id: string) {
    return this.service.getSources(id);
  }

  @Get(':id/classes')
  getClasses(@Param('id') id: string) {
    return this.service.getClasses(id);
  }

  @Get(':id/artifacts')
  getArtifacts(@Param('id') id: string) {
    return this.service.getArtifacts(id);
  }

  @Get(':id/samples')
  listSamples(
    @Param('id') id: string,
    @Query('split') split = 'train',
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.service.listSamples(id, split, intOr(limit, 24), Math.max(parseInt(offset ?? '0', 10) || 0, 0));
  }

  @Get(':id/samples/:split/:filename/image')
  async getSampleImage(
    @Param('id') id: string, @Param('split') split: string, @Param('filename') filename: string,
    @Res() res: Response,
  ) {
    const full = await this.service.getSampleImagePath(id, split, filename);
    res.sendFile(full);
  }

  @Get(':id/samples/:split/:filename/labels')
  getSampleLabels(@Param('id') id: string, @Param('split') split: string, @Param('filename') filename: string) {
    return this.service.getSampleLabels(id, split, filename);
  }
}
