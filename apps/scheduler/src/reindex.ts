import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Database } from '@model-trainer/db';

const REINDEX_EVENT = 'job.dataset_directory_reindex.dispatch';

// A RUNNING reindex whose worker died would block dispatch forever (the API's manual
// Rescan 409s on it too) — treat one with no heartbeat for this long as lost and
// re-dispatch over it.
const STALE_RUNNING_S = 15 * 60;

/**
 * Periodically refresh each dataset type's directory index, so the worker-side
 * reconcile (auto-archive / purge of source datasets whose folder vanished from
 * disk) happens without anyone pressing Rescan. Mirrors the API's
 * dispatchDirectoryReindex: upsert the per-type bookkeeping row to RUNNING and
 * enqueue the outbox event the dataset-worker consumes.
 *
 * Only types with their own dataset_path are considered (same rule as browse). A
 * type is due when its last reindex finished more than intervalS ago or never ran.
 */
export async function dispatchPeriodicReindexes(db: Kysely<Database>, intervalS: number): Promise<number> {
  if (intervalS <= 0) return 0;

  const due = await sql<{ id: string }>`
    SELECT t.id
    FROM app.dataset_types t
    LEFT JOIN app.dataset_type_reindexes r ON r.dataset_type_id = t.id
    WHERE t.dataset_path IS NOT NULL
      AND (
        r.dataset_type_id IS NULL
        OR (r.status <> 'RUNNING'
            AND coalesce(r.finished_at, r.started_at) < now() - make_interval(secs => ${intervalS}))
        OR (r.status = 'RUNNING'
            AND coalesce(r.heartbeat_at, r.started_at) < now() - make_interval(secs => ${STALE_RUNNING_S}))
      )
  `.execute(db);

  let dispatched = 0;
  for (const { id } of due.rows) {
    const correlationId = randomUUID();
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('dataset_type_reindexes').values({
        dataset_type_id: id, status: 'RUNNING', correlation_id: correlationId,
      }).onConflict((oc) => oc.column('dataset_type_id').doUpdateSet({
        status: 'RUNNING', correlation_id: correlationId, started_at: sql`now()`,
        heartbeat_at: sql`now()`, finished_at: null, error_message: null,
      })).execute();
      await trx.insertInto('outbox_events').values({
        event_type: REINDEX_EVENT,
        aggregate_type_code: 'DATASET_TYPE',
        aggregate_id: id,
        payload: { dataset_type_id: id, correlation_id: correlationId },
        correlation_id: correlationId,
      }).execute();
    });
    dispatched += 1;
  }
  return dispatched;
}
