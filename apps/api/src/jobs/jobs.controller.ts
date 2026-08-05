import { Controller, Get, Param, Query } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { JobsService, JOB_TYPE_LABEL } from './jobs.service';

const intOr = (v: string | undefined, d: number) => Math.max(parseInt(v ?? String(d), 10) || d, 1);

@Roles('ADMIN', 'USER')
@Controller('jobs')
export class JobsController {
  constructor(private readonly service: JobsService) {}

  @Get('types')
  types() {
    return Object.entries(JOB_TYPE_LABEL).map(([code, label]) => ({ code, label }));
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const item = await this.service.getById(id);
    return { data: item };
  }

  @Get()
  async list(
    @Query('page') page?: string, @Query('size') size?: string,
    @Query('job_type') jobType?: string,
    @Query('exec_status') execStatus?: string,
    @Query('business_status') businessStatus?: string,
    @Query('active') active?: string,
  ) {
    const p = intOr(page, 1);
    const s = intOr(size, 25);
    const result = await this.service.list({
      page: p, size: s,
      jobType, execStatus, businessStatus, active: active === 'true',
    });
    return {
      data: result.items,
      meta: { page: p, size: s, total: result.total, totalPages: Math.ceil(result.total / s) },
    };
  }
}
