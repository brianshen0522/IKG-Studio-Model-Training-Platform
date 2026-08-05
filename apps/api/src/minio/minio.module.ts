import { Module, Global } from '@nestjs/common';
import { MinioService } from './minio.service';
import { StorageController } from './storage.controller';

@Global()
@Module({
  controllers: [StorageController],
  providers: [MinioService],
  exports: [MinioService],
})
export class MinioModule {}
