import { randomUUID } from 'node:crypto';
import { Kysely, sql } from 'kysely';
import type { Database } from '@model-trainer/db';
import { logger } from './logger';
import { dispatchFreshTrainingJob } from './retry';

export interface PromoteResult {
  promoted: number;
  failed: number;
}

/**
 * Promote or fail BLOCKED training jobs based on the status of their dependencies.
 *  - any dep FAILED/CANCELLED/STOPPED -> job FAILED (DEPENDENCY_FAILED)
 *  - all deps COMPLETED (or no deps)   -> job QUEUED + dispatch first attempt
 *  - otherwise                         -> leave BLOCKED (deps still pending)
 *
 * Each job is handled in its own transaction with a guarded status update so a
 * concurrent state change by another actor is a safe no-op.
 */
export async function promoteBlockedTrainingJobs(db: Kysely<Database>): Promise<PromoteResult> {
  const candidates = await db
    .selectFrom('training_jobs')
    .select('id')
    .where('status', '=', 'BLOCKED')
    .execute();

  const result: PromoteResult = { promoted: 0, failed: 0 };

  for (const job of candidates) {
    const correlationId = randomUUID();
    try {
      await db.transaction().execute(async (trx) => {
        const row = await trx.selectFrom('training_jobs').select('id')
          .where('id', '=', job.id).forUpdate().executeTakeFirst();
        if (!row) return;

        const deps = await trx.selectFrom('training_job_dependencies as d')
          .innerJoin('training_jobs as dj', 'dj.id', 'd.depends_on_job_id')
          .select('dj.status')
          .where('d.job_id', '=', job.id)
          .execute();

        const anyFailed = deps.some(
          (d) => d.status === 'FAILED' || d.status === 'CANCELLED' || d.status === 'STOPPED',
        );
        const allDone = deps.length === 0 || deps.every((d) => d.status === 'COMPLETED');

        if (anyFailed) {
          const updated = await trx.updateTable('training_jobs').set({
            status: 'FAILED',
            failure_code: 'DEPENDENCY_FAILED',
            failure_message: 'a dependency ended in a failed/cancelled/stopped state',
            finished_at: sql`now()`,
            row_version: sql`row_version + 1`,
            updated_at: sql`now()`,
          }).where('id', '=', job.id).where('status', '=', 'BLOCKED').executeTakeFirst();
          if (updated && updated.numUpdatedRows > 0n) {
            await trx.insertInto('audit_logs').values({
              actor_type: 'SYSTEM',
              actor_ref: 'scheduler',
              action_code: 'TRAINING_JOB_FAILED',
              resource_type_code: 'TRAINING_JOB',
              resource_id: job.id,
              result: 'FAILURE',
              correlation_id: correlationId,
              error_code: 'DEPENDENCY_FAILED',
              metadata: { from: 'BLOCKED', to: 'FAILED' },
            }).execute();
            result.failed += 1;
          }
          return;
        }

        if (allDone) {
          const updated = await trx.updateTable('training_jobs').set({
            status: 'QUEUED',
            queued_at: sql`now()`,
            row_version: sql`row_version + 1`,
            updated_at: sql`now()`,
          }).where('id', '=', job.id).where('status', '=', 'BLOCKED').executeTakeFirst();
          if (!updated || updated.numUpdatedRows === 0n) return;

          await dispatchFreshTrainingJob(trx, job.id, correlationId);
          await trx.insertInto('audit_logs').values({
            actor_type: 'SYSTEM',
            actor_ref: 'scheduler',
            action_code: 'TRAINING_JOB_UNBLOCKED',
            resource_type_code: 'TRAINING_JOB',
            resource_id: job.id,
            result: 'SUCCESS',
            correlation_id: correlationId,
            metadata: { from: 'BLOCKED', to: 'QUEUED' },
          }).execute();
          result.promoted += 1;
        }
        // else: still BLOCKED (deps pending) — leave as-is.
      });
    } catch (err) {
      logger.warn('promoteBlockedTrainingJobs transaction failed', {
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
