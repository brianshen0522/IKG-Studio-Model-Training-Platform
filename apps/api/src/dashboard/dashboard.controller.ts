import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { DashboardService } from './dashboard.service';
import { GpuStatusService } from './gpu-status.service';

// SAFETY: `user` is absent from Express's Request type but is always populated by the
// global AuthGuard (APP_GUARD) before any handler runs; this controller is not @Public(),
// and @Roles('ADMIN','USER') requires an authenticated session, so the cast cannot see
// undefined here. Same pattern as the other feature controllers.
const actorOf = (req: Request) =>
  (req as unknown as Record<string, unknown>).user as { id: string; role: string };

@Roles('ADMIN', 'USER')
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly service: DashboardService,
    private readonly gpu: GpuStatusService,
  ) {}

  @Get('summary')
  summary(@Req() req: Request) {
    return this.service.summary(actorOf(req));
  }

  // Separate from `summary` so the dashboard can poll live GPU telemetry on a short
  // interval without re-running the summary's dozen aggregate counts every few seconds.
  @Get('gpu')
  gpu_() {
    return this.gpu.overview();
  }
}
