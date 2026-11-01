import { Controller, Sse, Req, type MessageEvent } from '@nestjs/common';
import type { Request } from 'express';
import { Observable, filter, from, interval, map, merge, switchMap, takeUntil } from 'rxjs';
import { Roles } from '../auth/decorators/roles.decorator';
import { SessionService } from '../auth/session.service';
import { SseService } from './sse.service';

// The guard only sees the request that opens the stream.
const SESSION_RECHECK_MS = 30_000;

@Roles('ADMIN', 'USER')
@Controller('events')
export class SseController {
  constructor(
    private readonly sse: SseService,
    private readonly sessions: SessionService,
  ) {}

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

    const token = this.sessions.extractToken(req as never) ?? '';
    const sessionEnded$ = interval(SESSION_RECHECK_MS).pipe(
      // A failed check is a database problem, not a revoked session.
      switchMap(() => from(this.sessions.isActive(token).catch(() => true))),
      filter((active) => !active),
    );

    return merge(events$, heartbeat$).pipe(takeUntil(sessionEnded$));
  }
}
