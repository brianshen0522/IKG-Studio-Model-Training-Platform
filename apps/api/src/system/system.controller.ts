import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';

@Controller('system')
export class SystemController {
  @Public()
  @Get('capabilities')
  capabilities() {
    return {
      task_types: {
        DETECT: { enabled: true },
        OBB: { enabled: true },
        SEGMENT: { enabled: false },
        POSE: { enabled: false },
        CLASSIFY: { enabled: false },
      },
      ultralytics_version: '8.x',
    };
  }
}
