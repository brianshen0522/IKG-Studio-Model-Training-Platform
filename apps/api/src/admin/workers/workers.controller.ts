import { Controller, Get } from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import { WorkersService } from './workers.service';

@Roles('ADMIN', 'USER')
@Controller('admin/workers')
export class WorkersController {
  constructor(private readonly service: WorkersService) {}

  @Get()
  list() {
    return this.service.list();
  }
}
