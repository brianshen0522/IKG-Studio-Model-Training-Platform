import { randomUUID } from 'node:crypto';
import { Kysely, sql } from 'kysely';
import type { Database } from '@model-trainer/db';
import { logger } from './logger';

export const DISPATCH_EVENT = 'job.training.dispatch';
const TERMINAL_JOB_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED', 'STOPPED'] as const;

/**
 * Worker-reported failure codes that represent transient infrastructure problems
 * and are therefore safe to auto-retry (doc 11 §26.1). Everything else — dataset
 * invalid, missing labels, bad model format, permission denied, config validation,
 * checksum mismatch, and any unrecognised/generic code — is treated as
 * non-retriable (§26.2), the safe default.
 *
 * Note: 'EXECUTION_LOST' is intentionally NOT here — liveness loss is handled by
 * the reconcile path, which owns its own attempt cap; retrying it here too would
 * double-count attempts.
 */
export const RETRIABLE_FAILURE_CODES = [
  'STORAGE_TEMPORARY_FAILURE',
  'DATABASE_CONNECTION_FAILURE',
  'NETWORK_TIMEOUT',
  'REDIS_TIMEOUT',
] as const;

export interface RetryDispatchOptions {
  jobId: string;
  correlationId: string;
  backoffBaseS: number;
  backoffCapS: number;
  reason: string;
  lostExecutionId?: string;
}

/**
 * Create the next training attempt for an already-requeued job: copies the config
 * snapshot from the latest execution, inserts a new ASSIGNED execution, enqueues a
 * delayed dispatch (exponential backoff via outbox available_at), and audits it.
 * The caller must have already moved the job to QUEUED inside the same transaction.
 */
export async function dispatchTrainingRetry(
  trx: Kysely<Database>,
  opts: RetryDispatchOptions,
): Promise<{ newExecutionId: string; nextAttempt: number; backoffS: number }> {
  const latest = await trx
    .selectFrom('job_executions')
    .select(['attempt_number', 'configuration_snapshot', 'configuration_hash'])
    .where('job_type', '=', 'TRAINING')
    .where('job_id', '=', opts.jobId)
    .orderBy('attempt_number', 'desc')
    .limit(1)
    .executeTakeFirstOrThrow();

  const nextAttempt = Number(latest.attempt_number) + 1;
  const backoffS = Math.min(opts.backoffBaseS * 2 ** Math.max(0, nextAttempt - 2), opts.backoffCapS);
  const assignmentToken = randomUUID();

  const inserted = await trx
    .insertInto('job_executions')
    .values({
      job_type: 'TRAINING',
      job_id: opts.jobId,
      attempt_number: nextAttempt,
      assignment_token: assignmentToken,
      configuration_snapshot: latest.configuration_snapshot,
      configuration_hash: latest.configuration_hash,
      correlation_id: opts.correlationId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await trx
    .insertInto('outbox_events')
    .values({
      event_type: DISPATCH_EVENT,
      aggregate_type_code: 'JOB_EXECUTION',
      aggregate_id: inserted.id,
      payload: {
        job_execution_id: inserted.id,
        assignment_token: assignmentToken,
        job_type: 'TRAINING',
        training_job_id: opts.jobId,
        correlation_id: opts.correlationId,
        attempt_number: nextAttempt,
      },
      correlation_id: opts.correlationId,
      available_at: sql`now() + make_interval(secs => ${backoffS})`,
    })
    .execute();

  await trx
    .insertInto('audit_logs')
    .values({
      actor_type: 'SYSTEM',
      actor_ref: 'scheduler',
      action_code: 'TRAINING_JOB_RETRY_SCHEDULED',
      resource_type_code: 'TRAINING_JOB',
      resource_id: opts.jobId,
      result: 'SUCCESS',
      correlation_id: opts.correlationId,
      metadata: {
        reason: opts.reason,
        next_attempt: nextAttempt,
        backoff_seconds: backoffS,
        new_execution_id: inserted.id,
        ...(opts.lostExecutionId ? { lost_execution_id: opts.lostExecutionId } : {}),
      },
    })
    .execute();

  return { newExecutionId: inserted.id, nextAttempt, backoffS };
}

/**
 * Create the FIRST attempt for a training job that has been freshly unblocked
 * (BLOCKED -> QUEUED): reads the config snapshot/hash from the JOB (not a prior
 * execution, since none exists yet), inserts an ASSIGNED execution, and enqueues an
 * immediate dispatch. No backoff (mirror the API submit path), no audit — the caller
 * owns the transition audit. Returns the new execution id.
 */
export async function dispatchFreshTrainingJob(
  trx: Kysely<Database>,
  jobId: string,
  correlationId: string,
): Promise<string> {
  const job = await trx
    .selectFrom('training_jobs')
    .select(['configuration_snapshot', 'configuration_hash'])
    .where('id', '=', jobId)
    .executeTakeFirstOrThrow();

  const maxRow = await trx
    .selectFrom('job_executions')
    .select(sql<number>`coalesce(max(attempt_number), 0)`.as('m'))
    .where('job_type', '=', 'TRAINING')
    .where('job_id', '=', jobId)
    .executeTakeFirstOrThrow();
  const nextAttempt = Number(maxRow.m) + 1;

  const assignmentToken = randomUUID();
  const { id: jobExecutionId } = await trx
    .insertInto('job_executions')
    .values({
      job_type: 'TRAINING',
      job_id: jobId,
      attempt_number: nextAttempt,
      assignment_token: assignmentToken,
      configuration_snapshot: job.configuration_snapshot,
      configuration_hash: job.configuration_hash,
      correlation_id: correlationId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await trx
    .insertInto('outbox_events')
    .values({
      event_type: DISPATCH_EVENT,
      aggregate_type_code: 'JOB_EXECUTION',
      aggregate_id: jobExecutionId,
      payload: {
        job_execution_id: jobExecutionId,
        assignment_token: assignmentToken,
        job_type: 'TRAINING',
        training_job_id: jobId,
        correlation_id: correlationId,
        attempt_number: nextAttempt,
      },
      correlation_id: correlationId,
    })
    .execute();

  return jobExecutionId;
}

export interface FailedRetryOptions {
  maxTrainingAttempts: number;
  backoffBaseS: number;
  staleTimeoutS: number;
  windowS: number;
}

/**
 * Retry training jobs the worker failed with a transient (retriable) failure code,
 * as long as attempts remain and the failure is recent. Requeues FAILED -> QUEUED
 * and dispatches a fresh attempt. Deterministic domain failures are left FAILED.
 */
export async function retryFailedTrainingJobs(
  db: Kysely<Database>,
  opts: FailedRetryOptions,
): Promise<number> {
  const candidates = await db
    .selectFrom('training_jobs')
    .select(['id', 'failure_code'])
    .where('status', '=', 'FAILED')
    .where('failure_code', 'in', RETRIABLE_FAILURE_CODES as unknown as string[])
    .where(sql<boolean>`finished_at > now() - make_interval(secs => ${opts.windowS})`)
    .execute();

  let retried = 0;
  const cap = Math.max(5, opts.staleTimeoutS - 30);

  for (const job of candidates) {
    try {
      await db.transaction().execute(async (trx) => {
        const maxRow = await trx
          .selectFrom('job_executions')
          .select(sql<number>`coalesce(max(attempt_number), 0)`.as('m'))
          .where('job_type', '=', 'TRAINING')
          .where('job_id', '=', job.id)
          .executeTakeFirstOrThrow();
        if (Number(maxRow.m) >= opts.maxTrainingAttempts) return; // attempts exhausted

        const latest = await trx
          .selectFrom('job_executions')
          .select('correlation_id')
          .where('job_type', '=', 'TRAINING')
          .where('job_id', '=', job.id)
          .orderBy('attempt_number', 'desc')
          .limit(1)
          .executeTakeFirst();
        const correlationId = latest?.correlation_id ?? randomUUID();

        // Guarded requeue: only if still FAILED (another actor may have acted).
        const requeued = await trx
          .updateTable('training_jobs')
          .set({
            status: 'QUEUED',
            failure_stage: null,
            failure_code: null,
            failure_message: null,
            finished_at: null,
            row_version: sql`row_version + 1`,
            updated_at: sql`now()`,
          })
          .where('id', '=', job.id)
          .where('status', '=', 'FAILED')
          .executeTakeFirst();
        if (!requeued || requeued.numUpdatedRows === 0n) return;

        const r = await dispatchTrainingRetry(trx, {
          jobId: job.id,
          correlationId,
          backoffBaseS: opts.backoffBaseS,
          backoffCapS: cap,
          reason: `error_retry:${job.failure_code}`,
        });
        retried += 1;
        logger.info('failed training job scheduled for retry', {
          jobId: job.id,
          failureCode: job.failure_code,
          newExecutionId: r.newExecutionId,
          nextAttempt: r.nextAttempt,
          backoffS: r.backoffS,
        });
      });
    } catch (err) {
      logger.warn('retryFailedTrainingJobs transaction failed', {
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return retried;
}

export { TERMINAL_JOB_STATUSES };
