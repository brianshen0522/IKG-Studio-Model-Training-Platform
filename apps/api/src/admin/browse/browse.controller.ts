import { Controller, Get, Query, HttpException } from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import { errorCode } from '@model-trainer/shared-types';
import { BrowseService } from './browse.service';

const badRequest = (message: string) =>
  new HttpException({ error: { code: errorCode.VALIDATION_FAILED, message, requestId: '' } }, 400);

@Roles('ADMIN', 'USER')
@Controller('admin/browse')
export class BrowseController {
  constructor(private readonly service: BrowseService) {}

  /** Absolute-path browse for picking dataset-type roots. Admin only. */
  @Roles('ADMIN')
  @Get('fs')
  async browseFs(@Query('path') path?: string) {
    return this.service.browseAbsolute(path || '');
  }

  /**
   * Status of a manually typed dataset-type root. Admin only.
   *
   * Deliberately does no format validation: the client rejects malformed paths before
   * calling, so anything reaching here is a real filesystem question.
   */
  @Roles('ADMIN')
  @Get('validate')
  async validateFs(@Query('path') path?: string) {
    if (!path || !path.trim()) throw badRequest('path is required');
    return this.service.validateAbsolute(path.trim());
  }

  @Get()
  async browse(
    @Query('dataset_type_id') datasetTypeId?: string,
    @Query('path') path?: string,
    @Query('root') root?: string,
  ) {
    if (!datasetTypeId) throw badRequest('dataset_type_id is required');
    if (root && root !== 'source' && root !== 'training') {
      throw badRequest("root must be 'source' or 'training'");
    }
    return this.service.browse(datasetTypeId, path || '', (root as 'source' | 'training') || 'source');
  }
}
