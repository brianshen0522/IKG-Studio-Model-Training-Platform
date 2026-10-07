import { Module, Global } from '@nestjs/common';
import { ObjectStoreService } from './object-store.service';
import { StorageController } from './storage.controller';

@Global()
@Module({
  controllers: [StorageController],
  providers: [ObjectStoreService],
  exports: [ObjectStoreService],
})
export class ObjectStoreModule {}
