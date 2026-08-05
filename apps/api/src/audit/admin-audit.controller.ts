import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuditActorType, AuditResult } from '@model-trainer/db';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminAuditService } from './admin-audit.service';

@Roles('ADMIN')
@Controller('admin/audit')
export class AdminAuditController {
  constructor(private readonly adminAuditService: AdminAuditService) {}

  // Declared before ':auditId' so the literal path isn't captured as a param.
  @Get('export')
  async export(
    @Res() res: Response,
    @Query('actorType') actorType?: AuditActorType,
    @Query('actorUserId') actorUserId?: string,
    @Query('actionCode') actionCode?: string,
    @Query('resourceType') resourceType?: string,
    @Query('resourceId') resourceId?: string,
    @Query('result') result?: AuditResult,
    @Query('correlationId') correlationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const csv = await this.adminAuditService.exportCsv({
      actorType, actorUserId, actionCode, resourceType, resourceId, result, correlationId, from, to,
    });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-export-${stamp}.csv"`);
    res.send(csv);
  }

  @Get('correlation/:correlationId')
  async getCorrelation(@Param('correlationId') correlationId: string) {
    const items = await this.adminAuditService.getByCorrelation(correlationId);
    return { data: items };
  }

  @Get(':auditId')
  async getDetail(@Param('auditId') auditId: string) {
    const row = await this.adminAuditService.getDetail(auditId);
    return { data: row };
  }

  @Get()
  async list(
    @Query('actorType') actorType?: AuditActorType,
    @Query('actorUserId') actorUserId?: string,
    @Query('actionCode') actionCode?: string,
    @Query('resourceType') resourceType?: string,
    @Query('resourceId') resourceId?: string,
    @Query('result') result?: AuditResult,
    @Query('correlationId') correlationId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('size') size?: string,
  ) {
    const listResult = await this.adminAuditService.list({
      actorType,
      actorUserId,
      actionCode,
      resourceType,
      resourceId,
      result,
      correlationId,
      from,
      to,
      page: Math.max(parseInt(page ?? '1', 10) || 1, 1),
      size: Math.min(Math.max(parseInt(size ?? '25', 10) || 25, 1), 100),
    });

    return {
      data: listResult.items,
      meta: {
        page: listResult.page,
        size: listResult.size,
        total: listResult.total,
        totalPages: Math.ceil(listResult.total / listResult.size),
      },
    };
  }
}
