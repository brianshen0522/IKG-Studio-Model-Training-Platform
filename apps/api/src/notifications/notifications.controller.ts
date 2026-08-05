import { Controller, Get, Post, Param, Query, Req, HttpCode } from '@nestjs/common';
import { Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { NotificationsService } from './notifications.service';

const actorOf = (req: Request) =>
  (req as unknown as Record<string, unknown>).user as { id: string; role: string };
const intOr = (v: string | undefined, d: number) => Math.max(parseInt(v ?? String(d), 10) || d, 1);

@Roles('ADMIN', 'USER')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get()
  async list(
    @Req() req: Request,
    @Query('page') page?: string, @Query('size') size?: string, @Query('unread') unread?: string,
    @Query('severity') severity?: string,
  ) {
    const result = await this.service.list(actorOf(req).id, {
      page: intOr(page, 1), size: intOr(size, 25), unreadOnly: unread === 'true', severity,
    });
    return {
      data: result.items,
      meta: { page: result.page, size: result.size, total: result.total, totalPages: Math.ceil(result.total / result.size) },
    };
  }

  @Get('unread-count')
  unreadCount(@Req() req: Request) {
    return this.service.unreadCount(actorOf(req).id);
  }

  @Post(':id/read')
  @HttpCode(200)
  markRead(@Param('id') id: string, @Req() req: Request) {
    return this.service.markRead(actorOf(req).id, id);
  }

  @Post('read-all')
  @HttpCode(200)
  markAllRead(@Req() req: Request) {
    return this.service.markAllRead(actorOf(req).id);
  }
}
