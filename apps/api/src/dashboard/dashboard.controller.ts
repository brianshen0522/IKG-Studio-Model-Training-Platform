import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { DashboardService } from './dashboard.service';

const actorOf = (req: Request) =>
  (req as unknown as Record<string, unknown>).user as { id: string; role: string };

@Roles('ADMIN', 'USER')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('summary')
  summary(@Req() req: Request) {
    return this.service.summary(actorOf(req));
  }
}
