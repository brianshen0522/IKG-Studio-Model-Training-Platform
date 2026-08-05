import { Inject, Injectable } from '@nestjs/common';
import { DB_PROVIDER } from '../database/database.module';
import { type Kysely, type Transaction } from 'kysely';
import type { Database } from '@model-trainer/db';
import { StructuredLoggerService } from '../common/logger/structured-logger.service';

export interface OutboxEnqueueParams {
  eventType: string;
  aggregateTypeCode: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  correlationId?: string;
}

@Injectable()
export class OutboxService {
  private readonly logger = new StructuredLoggerService();

  constructor(@Inject(DB_PROVIDER) private readonly db: Kysely<Database>) {}

  async enqueue(
    params: OutboxEnqueueParams,
    trx: Transaction<Database>,
  ): Promise<string> {
    const result = await trx
      .insertInto('outbox_events')
      .values({
        event_type: params.eventType,
        aggregate_type_code: params.aggregateTypeCode,
        aggregate_id: params.aggregateId,
        payload: params.payload,
        correlation_id: params.correlationId ?? crypto.randomUUID(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return result.id;
  }
}
