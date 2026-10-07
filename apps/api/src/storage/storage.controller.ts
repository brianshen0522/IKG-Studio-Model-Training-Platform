import { Controller, Get, Query } from '@nestjs/common';
import { ObjectStoreService } from './object-store.service';

@Controller('storage')
export class StorageController {
  constructor(private readonly store: ObjectStoreService) {}

  @Get('status')
  async getStatus(@Query('refresh') refresh?: string) {
    return this.store.getStorageStatus(refresh === 'true');
  }
}
