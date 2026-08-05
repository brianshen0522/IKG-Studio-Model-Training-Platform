import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
  Inject,
} from '@nestjs/common';
import { Observable, from, of, throwError } from 'rxjs';
import { switchMap, concatMap, catchError } from 'rxjs/operators';
import { createHash } from 'node:crypto';
import { type Kysely, sql } from 'kysely';
import type { Database } from '@model-trainer/db';
import { DB_PROVIDER } from '../../database/database.module';
import { errorCode } from '@model-trainer/shared-types';

// API idempotency (doc 17 §8, table 03 §27). Clients send `Idempotency-Key: <uuid>`
// on operations that could be duplicated by a network retry (submit / build / ingest / etc.).
//   same key + same request → replay the stored response
//   same key + different request → 409 IDEMPOTENCY_KEY_CONFLICT
// Registered OUTERMOST (before ResponseEnvelopeInterceptor) so the captured/replayed body is
// the final envelope. A reservation row is INSERTed *before* the handler runs, so two concurrent
// requests with the same key cannot both execute.
const TTL_HOURS = 24;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PG_UNIQUE_VIOLATION = '23505';

type ReserveResult =
  | { kind: 'reserved' }
  | { kind: 'replay'; status: number; body: Record<string, unknown> | null }
  | { kind: 'conflict'; message: string };

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@Inject(DB_PROVIDER) private readonly db: Kysely<Database>) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const rawKey = req.headers['idempotency-key'];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    const user = req.user as { id?: string } | undefined;

    // Only mutating, authenticated requests that actually carry a key are governed.
    if (!key || typeof key !== 'string' || !MUTATING.has(req.method) || !user?.id) {
      return next.handle();
    }

    const path: string = (req.originalUrl || req.url || '').split('?')[0];
    const operationCode = `${req.method} ${req.route?.path ?? path}`;
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ m: req.method, p: path, b: req.body ?? null }))
      .digest('hex');

    return from(this.reserve(key, user.id, operationCode, requestHash)).pipe(
      switchMap((r) => {
        if (r.kind === 'conflict') {
          throw new HttpException(
            { error: { code: errorCode.IDEMPOTENCY_KEY_CONFLICT, message: r.message, requestId: '' } },
            409,
          );
        }
        if (r.kind === 'replay') {
          res.status(r.status || 200);
          return of(r.body);
        }
        // Reserved: we own this execution. Persist the response before it is emitted, so a
        // retry that arrives after completion always finds a finished row to replay.
        return next.handle().pipe(
          concatMap(async (body) => {
            await this.persist(key, res.statusCode || 200, body).catch(() => undefined);
            return body;
          }),
          catchError((err) =>
            from(this.release(key).catch(() => undefined)).pipe(switchMap(() => throwError(() => err))),
          ),
        );
      }),
    );
  }

  private async reserve(
    key: string,
    userId: string,
    operationCode: string,
    requestHash: string,
  ): Promise<ReserveResult> {
    try {
      await this.db
        .insertInto('idempotency_keys')
        .values({
          idempotency_key: key,
          user_id: userId,
          operation_code: operationCode,
          request_hash: requestHash,
          expires_at: sql<string>`now() + make_interval(hours => ${TTL_HOURS})`,
        })
        .execute();
      return { kind: 'reserved' };
    } catch (e) {
      if ((e as { code?: string })?.code !== PG_UNIQUE_VIOLATION) throw e;
      // A row already exists for this key — inspect it.
      const row = await this.db
        .selectFrom('idempotency_keys')
        .select(['user_id', 'request_hash', 'response_status', 'response_body'])
        .where('idempotency_key', '=', key)
        .executeTakeFirst();
      if (!row) {
        return { kind: 'conflict', message: 'Idempotency-Key temporarily unavailable; please retry' };
      }
      if (row.user_id !== userId || row.request_hash !== requestHash) {
        return { kind: 'conflict', message: 'Idempotency-Key was reused with a different request' };
      }
      if (row.response_status !== null) {
        return { kind: 'replay', status: row.response_status, body: row.response_body };
      }
      return { kind: 'conflict', message: 'A request with this Idempotency-Key is already in progress' };
    }
  }

  private async persist(key: string, status: number, body: unknown): Promise<void> {
    await this.db
      .updateTable('idempotency_keys')
      .set({
        response_status: status,
        response_body: (body ?? null) as Record<string, unknown> | null,
      })
      .where('idempotency_key', '=', key)
      .where('response_status', 'is', null)
      .execute();
  }

  private async release(key: string): Promise<void> {
    await this.db
      .deleteFrom('idempotency_keys')
      .where('idempotency_key', '=', key)
      .where('response_status', 'is', null)
      .execute();
  }
}
