import { type Transaction, sql } from 'kysely';
import type { Database } from '@model-trainer/db';
import { HttpException } from '@nestjs/common';
import { errorCode } from '@model-trainer/shared-types';
import type { OutboxService } from '../outbox/outbox.service';

const REINDEX_EVENT = 'job.dataset_directory_reindex.dispatch';

const err = (code: string, message: string, status: number) =>
  new HttpException({ error: { code, message, requestId: '' } }, status);

/**
 * Dispatch a background folder-index refresh for one dataset type. Shared by
 * SourceDatasetsService (rescan button, lazy auto-dispatch on empty browse) and
 * DatasetTypesService (create / path change) — a plain function rather than an
 * injectable service so neither module needs to import the other's module.
 *
 * Throws DATASET_TYPE_REINDEX_ALREADY_RUNNING (409) if one is already in flight, unless
 * `force` is false and the caller wants best-effort dispatch (auto-triggers pass
 * force=false and swallow the conflict themselves).
 */
export async function dispatchDirectoryReindex(
  outboxService: OutboxService,
  trx: Transaction<Database>,
  datasetTypeId: string,
  correlationId: string,
): Promise<void> {
  const existing = await trx.selectFrom('dataset_type_reindexes')
    .select('status').where('dataset_type_id', '=', datasetTypeId).forUpdate().executeTakeFirst();
  if (existing?.status === 'RUNNING') {
    throw err(errorCode.DATASET_TYPE_REINDEX_ALREADY_RUNNING, 'a reindex is already running for this dataset type', 409);
  }
  await trx.insertInto('dataset_type_reindexes').values({
    dataset_type_id: datasetTypeId, status: 'RUNNING', correlation_id: correlationId,
  }).onConflict((oc) => oc.column('dataset_type_id').doUpdateSet({
    status: 'RUNNING', correlation_id: correlationId, started_at: sql`now()`,
    heartbeat_at: sql`now()`, finished_at: null, error_message: null,
  })).execute();

  await outboxService.enqueue({
    eventType: REINDEX_EVENT, aggregateTypeCode: 'DATASET_TYPE', aggregateId: datasetTypeId,
    payload: { dataset_type_id: datasetTypeId, correlation_id: correlationId } as Record<string, unknown>,
    correlationId,
  }, trx);
}

/** True if a RUNNING reindex row exists for this type (used to skip redundant auto-dispatch). */
export async function isReindexRunning(trx: Transaction<Database>, datasetTypeId: string): Promise<boolean> {
  const row = await trx.selectFrom('dataset_type_reindexes')
    .select('status').where('dataset_type_id', '=', datasetTypeId).executeTakeFirst();
  return row?.status === 'RUNNING';
}
