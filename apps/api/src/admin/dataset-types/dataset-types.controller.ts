import {
  Controller, Get, Post, Patch, Delete, Param, Body, Query, Req, HttpCode, HttpException,
} from '@nestjs/common';
import { Request } from 'express';
import { Roles } from '../../auth/decorators/roles.decorator';
import { errorCode } from '@model-trainer/shared-types';
import { DatasetTypesService } from './dataset-types.service';

const actorOf = (req: Request) =>
  (req as unknown as Record<string, unknown>).user as { id: string; role: string };
const badRequest = (message: string) =>
  new HttpException({ error: { code: errorCode.VALIDATION_FAILED, message, requestId: '' } }, 400);

@Roles('ADMIN')
@Controller('admin/dataset-types')
export class DatasetTypesController {
  constructor(private readonly service: DatasetTypesService) {}

  @Get('tree')
  tree() {
    return this.service.getTree();
  }

  @Post('reorder')
  @HttpCode(200)
  async reorder(
    @Body() body: { parent_id?: string | null; items?: { dataset_type_id: string; sort_order: number; row_version: number }[] } = {},
    @Req() req: Request,
  ) {
    if (!Array.isArray(body.items) || body.items.length === 0) throw badRequest('items is required');
    return this.service.reorder({ parent_id: body.parent_id ?? null, items: body.items }, actorOf(req));
  }

  @Get()
  list() {
    return this.service.list();
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: {
      name?: string; parent_id?: string | null; description?: string | null;
      icon?: string | null; color?: string | null;
      dataset_path?: string | null; model_path?: string | null; training_dataset_path?: string | null; sort_order?: number; enabled?: boolean;
    } = {},
    @Req() req: Request,
  ) {
    if (!body.name) throw badRequest('name is required');
    return this.service.create({ ...body, name: body.name }, actorOf(req));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: {
      name?: string; description?: string | null; icon?: string | null; color?: string | null;
      dataset_path?: string | null; model_path?: string | null; training_dataset_path?: string | null;
      sort_order?: number; enabled?: boolean; row_version?: number;
    } = {},
    @Req() req: Request,
  ) {
    if (body.row_version === undefined || body.row_version === null) throw badRequest('row_version is required');
    return this.service.update(id, { ...body, row_version: body.row_version }, actorOf(req));
  }

  @Post(':id/enable')
  @HttpCode(200)
  enable(@Param('id') id: string, @Req() req: Request) {
    return this.service.enable(id, actorOf(req));
  }

  @Post(':id/disable')
  @HttpCode(200)
  disable(@Param('id') id: string, @Req() req: Request) {
    return this.service.disable(id, actorOf(req));
  }

  @Post(':id/move')
  @HttpCode(200)
  async move(
    @Param('id') id: string,
    @Body() body: { new_parent_id?: string | null; new_sort_order?: number; row_version?: number } = {},
    @Req() req: Request,
  ) {
    if (body.row_version === undefined || body.row_version === null) throw badRequest('row_version is required');
    return this.service.move(id, { new_parent_id: body.new_parent_id ?? null, new_sort_order: body.new_sort_order, row_version: body.row_version }, actorOf(req));
  }

  @Delete(':id')
  @HttpCode(200)
  remove(@Param('id') id: string, @Req() req: Request) {
    return this.service.delete(id, actorOf(req));
  }

  @Get(':id/usage')
  usage(@Param('id') id: string) {
    return this.service.usage(id);
  }

  @Get(':id/history')
  history(@Param('id') id: string, @Query('cursor') cursor?: string, @Query('size') size?: string) {
    return this.service.history(id, cursor ? Number(cursor) : undefined, size ? Number(size) : undefined);
  }
}
