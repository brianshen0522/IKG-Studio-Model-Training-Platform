import { Controller, Get, Query } from '@nestjs/common';
import { MinioService } from './minio.service';

@Controller('storage')
export class StorageController {
  constructor(private readonly minio: MinioService) {}

  @Get('status')
  async getStatus(@Query('refresh') refresh?: string) {
    return this.minio.getStorageStatus(refresh === 'true');
  }
}
