import { Inject, Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { DB_PROVIDER } from '../database/database.module';
import { REDIS_PROVIDER } from '../redis/redis.module';
import { type Kysely, sql } from 'kysely';
import { type Redis } from 'ioredis';
import type { Database, OutboxStatus } from '@model-trainer/db';
import { StructuredLoggerService } from '../common/logger/structured-logger.service';

const POLL_INTERVAL_MS = 1000;
const BATCH_SIZE = 10;
const STREAM_KEY = 'events';
const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_S = 2;
const MAX_BACKOFF_S = 300;

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new StructuredLoggerService();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(DB_PROVIDER) private readonly db: Kysely<Database>,
    @Inject(REDIS_PROVIDER) private readonly redis: Redis,
  ) {}

  onModuleInit() {
    this.intervalHandle = setInterval(() => this.tick(), POLL_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  private async tick(): Promise<void> {
    try {
      await this.db.transaction().execute(async (trx) => {
        const rows = await trx
          .selectFrom('outbox_events')
          .select([
            'id',
            'event_type',
            'aggregate_type_code',
            'aggregate_id',
            'payload',
            'correlation_id',
            'attempt_count',
          ])
          .where((eb) =>
            eb.or([
              eb('status', '=', 'PENDING' as OutboxStatus),
              eb('status', '=', 'FAILED' as OutboxStatus),
            ]),
          )
          .where('available_at', '<=', sql<string>`now()`)
          .orderBy('created_at', 'asc')
          .limit(BATCH_SIZE)
          .forUpdate()
          .skipLocked()
          .execute();

        if (rows.length === 0) return;

        const ids = rows.map((r) => r.id);

        await trx
          .updateTable('outbox_events')
          .set({ status: 'PROCESSING' as OutboxStatus })
          .where('id', 'in', ids)
          .where('status', 'in', ['PENDING' as OutboxStatus, 'FAILED' as OutboxStatus])
          .execute();

        for (const row of rows) {
          try {
            await this.redis.xadd(
              STREAM_KEY,
              '*',
              'event_type',
              row.event_type,
              'aggregate_type_code',
              row.aggregate_type_code,
              'aggregate_id',
              row.aggregate_id,
              'payload',
              JSON.stringify(row.payload),
              'correlation_id',
              row.correlation_id,
            );

            await trx
              .updateTable('outbox_events')
              .set({
                status: 'PUBLISHED' as OutboxStatus,
                published_at: sql`now()`,
                attempt_count: row.attempt_count + 1,
              })
              .where('id', '=', row.id)
              .execute();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const nextAttempt = row.attempt_count + 1;

            if (nextAttempt >= MAX_ATTEMPTS) {
              await trx
                .updateTable('outbox_events')
                .set({
                  status: 'DEAD' as OutboxStatus,
                  attempt_count: nextAttempt,
                  last_error: message,
                })
                .where('id', '=', row.id)
                .execute();

              this.logger.error(`Outbox event moved to dead-letter after max attempts`, {
                id: row.id,
                correlation_id: row.correlation_id,
                attempt_count: nextAttempt,
                error_code: 'OUTBOX_DEAD_LETTER',
              });
            } else {
              const backoffS = Math.min(BASE_BACKOFF_S * 2 ** (nextAttempt - 1), MAX_BACKOFF_S);
              await trx
                .updateTable('outbox_events')
                .set({
                  status: 'FAILED' as OutboxStatus,
                  attempt_count: nextAttempt,
                  last_error: message,
                  available_at: sql`now() + make_interval(secs => ${backoffS})`,
                })
                .where('id', '=', row.id)
                .execute();

              this.logger.error(`Outbox publish failed for ${row.id}`, {
                correlation_id: row.correlation_id,
                error_code: 'OUTBOX_PUBLISH_FAILED',
                backoff_s: backoffS,
              });
            }
          }
        }
      });
    } catch (err) {
      this.logger.error('Outbox tick error', {
        error_code: 'OUTBOX_TICK_ERROR',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
