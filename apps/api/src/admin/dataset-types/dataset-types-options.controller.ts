import { Controller, Get } from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import { DatasetTypesService } from './dataset-types.service';

// Selector for normal Dataset/Model forms — readable by any authenticated user.
@Roles('ADMIN', 'USER')
@Controller('dataset-types')
export class DatasetTypesOptionsController {
  constructor(private readonly service: DatasetTypesService) {}

  // Took an `include_unclassified` flag until the Unclassified type was removed in 003.
  // Callers that still send it are simply ignored.
  @Get('options')
  options() {
    return this.service.options();
  }
}
