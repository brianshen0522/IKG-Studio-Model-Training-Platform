import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SseService } from './sse.service';
import { SseController } from './sse.controller';

@Module({
  imports: [AuthModule],
  controllers: [SseController],
  providers: [SseService],
})
export class EventsModule {}
