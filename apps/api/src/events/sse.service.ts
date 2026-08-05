import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import pg from 'pg';
import { StructuredLoggerService } from '../common/logger/structured-logger.service';
import { loadEnv } from '../config/config.schema';

export interface SseMessage {
  type: string;
  data: unknown;
}

/**
 * Bridges Postgres NOTIFY → per-user SSE streams. A single dedicated LISTEN connection
 * receives `sse_events` payloads (emitted by DB triggers, e.g. on notification insert)
 * and fans them out to the RxJS Subjects of the matching connected user.
 */
@Injectable()
export class SseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new StructuredLoggerService();
  private readonly subscribers = new Map<string, Set<Subject<SseMessage>>>();
  private client: pg.Client | null = null;
  private closing = false;

  onModuleInit(): void {
    this.connect();
  }

  onModuleDestroy(): void {
    this.closing = true;
    this.client?.end().catch(() => undefined);
    for (const set of this.subscribers.values()) {
      for (const subject of set) subject.complete();
    }
    this.subscribers.clear();
  }

  private connect(): void {
    if (this.closing) return;
    const env = loadEnv();
    const client = new pg.Client({
      host: env.POSTGRES_HOST,
      port: env.POSTGRES_PORT,
      database: env.POSTGRES_DB,
      user: env.POSTGRES_USER,
      password: env.POSTGRES_PASSWORD,
    });
    this.client = client;

    client.on('notification', (msg) => this.dispatch(msg.payload));
    client.on('error', (err) => {
      this.logger.error('SSE LISTEN connection error', { error_code: 'SSE_LISTEN_ERROR', message: err.message });
      this.reconnect();
    });

    client
      .connect()
      .then(() => client.query('LISTEN sse_events'))
      .then(() => this.logger.log('SSE LISTEN active on sse_events'))
      .catch((err) => {
        this.logger.error('SSE LISTEN connect failed', {
          error_code: 'SSE_LISTEN_CONNECT_FAILED',
          message: err instanceof Error ? err.message : String(err),
        });
        this.reconnect();
      });
  }

  private reconnect(): void {
    if (this.closing) return;
    const stale = this.client;
    this.client = null;
    if (stale) {
      stale.removeAllListeners();
      stale.end().catch(() => undefined);
    }
    setTimeout(() => this.connect(), 2000);
  }

  private dispatch(payload?: string): void {
    if (!payload) return;
    let event: { type?: string; user_id?: string };
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    const message: SseMessage = { type: event.type ?? 'message', data: event };
    if (event.user_id) {
      // User-scoped event (e.g. a notification) → only that user's streams.
      const set = this.subscribers.get(event.user_id);
      if (set) for (const subject of set) subject.next(message);
    } else {
      // Broadcast event (e.g. a job status change, visible to all authed users).
      for (const set of this.subscribers.values()) {
        for (const subject of set) subject.next(message);
      }
    }
  }

  /** A stream of this user's events; the connection cleans itself up on unsubscribe. */
  subscribe(userId: string): Observable<SseMessage> {
    const subject = new Subject<SseMessage>();
    let set = this.subscribers.get(userId);
    if (!set) {
      set = new Set();
      this.subscribers.set(userId, set);
    }
    set.add(subject);

    return new Observable<SseMessage>((observer) => {
      const inner = subject.subscribe(observer);
      return () => {
        inner.unsubscribe();
        const current = this.subscribers.get(userId);
        if (current) {
          current.delete(subject);
          if (current.size === 0) this.subscribers.delete(userId);
        }
        subject.complete();
      };
    });
  }
}
