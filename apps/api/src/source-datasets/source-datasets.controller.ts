import {
  Controller, Get, Post, Param, Body, Query, Req, Res, HttpCode, HttpException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { errorCode } from '@model-trainer/shared-types';
import type { DatasetTaskType } from '@model-trainer/db';
import { SourceDatasetsService } from './source-datasets.service';

const actorOf = (req: Request) =>
  (req as unknown as Record<string, unknown>).user as { id: string; role: string };
const badRequest = (message: string) =>
  new HttpException({ error: { code: errorCode.VALIDATION_FAILED, message, requestId: '' } }, 400);
const intOr = (v: string | undefined, d: number) => Math.max(parseInt(v ?? String(d), 10) || d, 1);

@Roles('ADMIN', 'USER')
@Controller('source-datasets')
export class SourceDatasetsController {
  constructor(private readonly service: SourceDatasetsService) {}

  @Post()
  @HttpCode(201)
  async register(
    @Body() body: {
      name?: string; dataset_type_id?: string; task_type?: DatasetTaskType;
      sub_path?: string | null;
      images_relative_path?: string; labels_relative_path?: string;
      classes_file_relative_path?: string | null; allow_subdirectories?: boolean;
      split_layout?: Record<string, unknown>; notes?: string | null;
    } = {},
    @Req() req: Request,
  ) {
    if (!body.name || !body.dataset_type_id || !body.task_type) {
      throw badRequest('name, dataset_type_id, task_type are required');
    }
    return this.service.register({
      name: body.name, dataset_type_id: body.dataset_type_id, task_type: body.task_type,
      sub_path: body.sub_path,
      images_relative_path: body.images_relative_path, labels_relative_path: body.labels_relative_path,
      classes_file_relative_path: body.classes_file_relative_path,
      allow_subdirectories: body.allow_subdirectories, split_layout: body.split_layout, notes: body.notes,
    }, actorOf(req));
  }

  @Get()
  async list(
    @Query('page') page?: string, @Query('size') size?: string,
    @Query('dataset_type_id') datasetTypeId?: string, @Query('task_type') taskType?: string,
    @Query('status') status?: string, @Query('archived') archived?: string,
  ) {
    const result = await this.service.list({
      page: intOr(page, 1), size: intOr(size, 25),
      dataset_type_id: datasetTypeId, task_type: taskType, status, archived: archived === 'true',
    });
    return {
      data: result.items,
      meta: { page: result.page, size: result.size, total: result.total, totalPages: Math.ceil(result.total / result.size) },
    };
  }

  @Get('available')
  async available(@Query('dataset_type_id') datasetTypeId?: string) {
    if (!datasetTypeId) throw badRequest('dataset_type_id is required');
    return this.service.available(datasetTypeId);
  }

  @Get('by-type')
  browseByType() {
    return this.service.browseByType();
  }

  @Post('validate-classes')
  @HttpCode(200)
  async validateClasses(@Body() body: { source_dataset_ids?: string[] } = {}) {
    if (!body.source_dataset_ids || body.source_dataset_ids.length === 0) {
      throw badRequest('source_dataset_ids is required');
    }
    return this.service.validateClasses(body.source_dataset_ids);
  }

  @Post('ensure')
  @HttpCode(200)
  async ensure(
    @Body() body: { dataset_type_id?: string; sub_path?: string; task_type?: DatasetTaskType; name?: string } = {},
    @Req() req: Request,
  ) {
    if (!body.dataset_type_id || body.sub_path === undefined) {
      throw badRequest('dataset_type_id and sub_path are required');
    }
    return this.service.ensure(
      { dataset_type_id: body.dataset_type_id, sub_path: body.sub_path, task_type: body.task_type, name: body.name },
      actorOf(req),
    );
  }

  @Post('types/:id/rescan')
  @HttpCode(202)
  rescanType(@Param('id') id: string, @Req() req: Request) {
    return this.service.rescanType(id, actorOf(req));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Post(':id/rescan')
  @HttpCode(202)
  rescan(@Param('id') id: string, @Req() req: Request) {
    return this.service.rescan(id, actorOf(req));
  }

  @Post(':id/classes-override')
  @HttpCode(200)
  setClassesOverride(
    @Param('id') id: string,
    @Body() body: { class_names?: string[] | null } = {},
    @Req() req: Request,
  ) {
    return this.service.setClassesOverride(id, body.class_names ?? null, actorOf(req));
  }

  @Get(':id/scans')
  listScans(@Param('id') id: string) {
    return this.service.listScans(id);
  }

  @Get(':id/scans/:scanId')
  getScan(@Param('id') id: string, @Param('scanId') scanId: string) {
    return this.service.getScan(id, scanId);
  }

  @Get(':id/scans/:scanId/classes')
  getScanClasses(
    @Param('id') id: string, @Param('scanId') scanId: string,
    @Query('page') page?: string, @Query('size') size?: string,
  ) {
    return this.service.getScanClasses(id, scanId, intOr(page, 1), intOr(size, 50));
  }

  @Get(':id/scans/:scanId/issues')
  getScanIssues(
    @Param('id') id: string, @Param('scanId') scanId: string,
    @Query('page') page?: string, @Query('size') size?: string, @Query('severity') severity?: string,
  ) {
    return this.service.getScanIssues(id, scanId, intOr(page, 1), intOr(size, 50), severity);
  }

  @Get(':id/samples')
  listSamples(
    @Param('id') id: string,
    @Query('limit') limit?: string, @Query('offset') offset?: string,
  ) {
    return this.service.listSamples(id, intOr(limit, 24), Math.max(parseInt(offset ?? '0', 10) || 0, 0));
  }

  @Get(':id/samples/:filename/image')
  async getSampleImage(
    @Param('id') id: string, @Param('filename') filename: string,
    @Res() res: Response,
  ) {
    const full = await this.service.getSampleImagePath(id, filename);
    res.sendFile(full);
  }

  @Get(':id/samples/:filename/labels')
  getSampleLabels(@Param('id') id: string, @Param('filename') filename: string) {
    return this.service.getSampleLabels(id, filename);
  }
}
