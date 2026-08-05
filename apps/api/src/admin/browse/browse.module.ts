import { Module } from '@nestjs/common';
import { DatasetTypesTreeService } from '../dataset-types/dataset-types-tree.service';
import { BrowseController } from './browse.controller';
import { BrowseService } from './browse.service';

@Module({
  controllers: [BrowseController],
  providers: [BrowseService, DatasetTypesTreeService],
})
export class BrowseModule {}
