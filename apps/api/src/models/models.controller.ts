import { Controller, Get, Post, Delete, Param, Body, Query, Req, HttpCode, HttpException, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { errorCode } from '@model-trainer/shared-types';
import type { DatasetTaskType } from '@model-trainer/db';
import { ModelsService } from './models.service';
import { AdminAuditService } from '../audit/admin-audit.service';

const actorOf = (req: Request) =>
  (req as unknown as Record<string, unknown>).user as { id: string; role: string };
const badRequest = (message: string) =>
  new HttpException({ error: { code: errorCode.VALIDATION_FAILED, message, requestId: '' } }, 400);
const intOr = (v: string | undefined, d: number) => Math.max(parseInt(v ?? String(d), 10) || d, 1);

@Roles('ADMIN', 'USER')
@Controller('models')
export class ModelsController {
  constructor(
    private readonly service: ModelsService,
    private readonly adminAudit: AdminAuditService,
  ) {}

  @Get(':id/history')
  async history(@Param('id') id: string) {
    return { data: await this.adminAudit.historyForResource('MODEL', id) };
  }

  @Post('ingest/url')
  @HttpCode(202)
  ingestUrl(
    @Body() body: {
      name?: string; version_label?: string | null; description?: string | null;
      dataset_type_id?: string; task_type?: DatasetTaskType; source_url?: string;
      expected_checksum?: string | null; expected_size_bytes?: number | null;
    } = {},
    @Req() req: Request,
  ) {
    if (!body.name || !body.dataset_type_id || !body.task_type || !body.source_url) {
      throw badRequest('name, dataset_type_id, task_type, source_url are required');
    }
    return this.service.ingestFromUrl({
      name: body.name, version_label: body.version_label, description: body.description,
      dataset_type_id: body.dataset_type_id, task_type: body.task_type, source_url: body.source_url,
      expected_checksum: body.expected_checksum, expected_size_bytes: body.expected_size_bytes,
    }, actorOf(req));
  }

  @Post('ingest/upload')
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 * 1024 } }))
  uploadModel(
    @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined,
    @Body() body: {
      name?: string; version_label?: string | null; description?: string | null;
      dataset_type_id?: string; task_type?: DatasetTaskType; expected_checksum?: string | null;
    } = {},
    @Req() req: Request,
  ) {
    if (!file) throw badRequest('file is required');
    if (!body.name || !body.dataset_type_id || !body.task_type) {
      throw badRequest('name, dataset_type_id, task_type are required');
    }
    return this.service.uploadModel({
      name: body.name, version_label: body.version_label, description: body.description,
      dataset_type_id: body.dataset_type_id, task_type: body.task_type, original_filename: file.originalname,
      expected_checksum: body.expected_checksum,
    }, file.buffer, actorOf(req));
  }

  @Get('ingest-tasks/:id')
  getIngestTask(@Param('id') id: string) {
    return this.service.getIngestTask(id);
  }

  @Get()
  async list(
    @Query('page') page?: string, @Query('size') size?: string,
    @Query('dataset_type_id') datasetTypeId?: string, @Query('task_type') taskType?: string,
    @Query('source_type') sourceType?: string, @Query('status') status?: string, @Query('archived') archived?: string,
  ) {
    const result = await this.service.listModels({
      page: intOr(page, 1), size: intOr(size, 25),
      dataset_type_id: datasetTypeId, task_type: taskType, source_type: sourceType, status, archived: archived === 'true',
    });
    return {
      data: result.items,
      meta: { page: result.page, size: result.size, total: result.total, totalPages: Math.ceil(result.total / result.size) },
    };
  }

  /** Poll target for a dispatched scan. Declared before `:id` so it is not swallowed by it. */
  @Get('scan-status')
  scanStatus(@Query('correlation_id') correlationId: string | undefined) {
    if (!correlationId) throw badRequest('correlation_id is required');
    return this.service.scanStatus(correlationId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.getModel(id);
  }

  /** What deleting this model would leave dangling — shown in the delete confirmation. */
  @Get(':id/associations')
  associations(@Param('id') id: string) {
    return this.service.associations(id);
  }

  /** Hard action on the model's own data (soft-delete + disk .pt removal); see ModelsService.deleteModel. */
  @Delete(':id')
  @Roles('ADMIN')
  @HttpCode(200)
  remove(@Param('id') id: string, @Req() req: Request) {
    return this.service.deleteModel(id, actorOf(req));
  }

  /** Discover models on disk. Optional ?dataset_type_id= limits it to one type. */
  @Post('scan')
  @HttpCode(202)
  scan(@Query('dataset_type_id') datasetTypeId: string | undefined, @Req() req: Request) {
    return this.service.requestScan(datasetTypeId || null, actorOf(req));
  }

}
