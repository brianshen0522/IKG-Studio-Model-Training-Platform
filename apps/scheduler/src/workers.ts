import { type Kysely, sql } from 'kysely';
import type { Database } from '@model-trainer/db';

export async function markStaleWorkersOffline(
  db: Kysely<Database>,
  offlineTimeoutS: number,
): Promise<number> {
  const result = await sql`
    UPDATE workers
    SET status = 'OFFLINE', updated_at = now()
    WHERE status <> 'OFFLINE'
      AND disabled_at IS NULL
      AND last_heartbeat_at < now() - make_interval(secs => ${sql.lit(offlineTimeoutS)})
    RETURNING worker_key
  `.execute(db);
  return result.rows.length;
}
