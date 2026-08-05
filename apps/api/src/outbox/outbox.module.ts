import { Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';
import { OutboxPublisher } from './outbox.publisher';

@Module({
  providers: [OutboxService, OutboxPublisher],
  exports: [OutboxService],
})
export class OutboxModule {}
