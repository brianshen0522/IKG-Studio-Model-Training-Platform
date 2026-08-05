import { Controller, Sse, Req, type MessageEvent } from '@nestjs/common';
import type { Request } from 'express';
import { Observable, interval, map, merge } from 'rxjs';
import { Roles } from '../auth/decorators/roles.decorator';
import { SseService } from './sse.service';

@Roles('ADMIN', 'USER')
@Controller('events')
export class SseController {
  constructor(private readonly sse: SseService) {}

  // GET /api/v1/events/stream — authenticated via the session cookie (EventSource sends it).
  // nginx proxies /api/v1/events/ with buffering off + long read timeout.
  @Sse('stream')
  stream(@Req() req: Request): Observable<MessageEvent> {
    const userId = ((req as unknown as { user?: { id?: string } }).user?.id ?? '') as string;

    const events$ = this.sse.subscribe(userId).pipe(
      map((m): MessageEvent => ({ type: m.type, data: m.data as string | object })),
    );
    // Keep-alive so idle proxies/browsers don't drop the connection.
    const heartbeat$ = interval(30_000).pipe(map((): MessageEvent => ({ type: 'ping', data: {} })));

    return merge(events$, heartbeat$);
  }
}
