import { Kysely, sql } from 'kysely';
import type { Database, JobExecutionStatus } from '@model-trainer/db';
import { logger } from './logger';
import { dispatchTrainingRetry, TERMINAL_JOB_STATUSES } from './retry';

const ACTIVE_STATUSES: JobExecutionStatus[] = ['ASSIGNED', 'CLAIMED', 'PREPARING', 'RUNNING'];

export interface RetryOptions {
  maxTrainingAttempts: number;
  backoffBaseS: number;
}

export interface ReconcileResult {
  lost: number;
  retried: number;
  failed: number;
}

/**
 * A benchmark evaluation whose execution was lost: mark the evaluation FAILED and
 * re-finalise its parent run (mirrors the worker's _finalize_run, doc 09), so a run
 * never hangs in RUNNING because one worker died. Notifications are skipped
 * (scheduler_role has no INSERT on notifications) — consistent with the training path.
 * Returns true if the evaluation was actually transitioned (was still active).
 */
async function finalizeBenchmarkOnLost(
  trx: Kysely<Database>,
  evalId: string,
  correlationId: string,
): Promise<boolean> {
  const failed = await trx
    .updateTable('benchmark_evaluations')
    .set({
      status: 'FAILED',
      finished_at: sql`now()`,
      failure_code: 'EXECUTION_LOST',
      failure_message: 'Execution lost (heartbeat timeout)',
    })
    .where('id', '=', evalId)
    .where('status', 'in', ['PENDING', 'QUEUED', 'RUNNING'])
    .executeTakeFirst();

  if (!failed || failed.numUpdatedRows === 0n) return false;

  const evalRow = await trx
    .selectFrom('benchmark_evaluations')
    .select('benchmark_run_id')
    .where('id', '=', evalId)
    .executeTakeFirstOrThrow();
  const runId = evalRow.benchmark_run_id;

  await trx
    .insertInto('audit_logs')
    .values({
      actor_type: 'SYSTEM',
      actor_ref: 'scheduler',
      action_code: 'BENCHMARK_EVALUATION_FAILED',
      resource_type_code: 'BENCHMARK_EVALUATION',
      resource_id: evalId,
      result: 'FAILURE',
      correlation_id: correlationId,
      error_code: 'EXECUTION_LOST',
      metadata: { benchmark_run_id: runId },
    })
    .execute();

  // Recompute run counts and finalise if no evaluations remain active.
  const counts = await trx
    .selectFrom('benchmark_evaluations')
    .select([
      sql<string>`count(*) filter (where status = 'COMPLETED')`.as('completed'),
      sql<string>`count(*) filter (where status = 'FAILED')`.as('failed'),
      sql<string>`count(*) filter (where status not in ('COMPLETED','FAILED','CANCELLED'))`.as('pending'),
      sql<string>`count(*)`.as('total'),
    ])
    .where('benchmark_run_id', '=', runId)
    .executeTakeFirstOrThrow();

  const completed = Number(counts.completed);
  const failedCount = Number(counts.failed);
  const pending = Number(counts.pending);
  const total = Number(counts.total);

  await trx
    .updateTable('benchmark_runs')
    .set({ completed_count: completed, failed_count: failedCount, updated_at: sql`now()` })
    .where('id', '=', runId)
    .execute();

  if (pending === 0 && total > 0) {
    const runStatus =
      failedCount === 0 ? 'COMPLETED' : completed > 0 ? 'PARTIALLY_FAILED' : 'FAILED';
    const finalised = await trx
      .updateTable('benchmark_runs')
      .set({ status: runStatus, finished_at: sql`now()`, updated_at: sql`now()` })
      .where('id', '=', runId)
      .where('status', '=', 'RUNNING')
      .executeTakeFirst();

    if (finalised && finalised.numUpdatedRows > 0n) {
      await trx
        .insertInto('audit_logs')
        .values({
          actor_type: 'SYSTEM',
          actor_ref: 'scheduler',
          action_code: 'BENCHMARK_RUN_FINISHED',
          resource_type_code: 'BENCHMARK_RUN',
          resource_id: runId,
          result: runStatus === 'COMPLETED' ? 'SUCCESS' : 'FAILURE',
          correlation_id: correlationId,
          metadata: { status: runStatus, completed, failed: failedCount },
        })
        .execute();
    }
  }

  return true;
}

export async function reconcileStaleExecutions(
  db: Kysely<Database>,
  staleTimeoutS: number,
  retry: RetryOptions,
): Promise<ReconcileResult> {
  const candidates = await db
    .selectFrom('job_executions')
    .select([
      'id',
      'job_type',
      'job_id',
      'attempt_number',
      'correlation_id',
      'configuration_snapshot',
      'configuration_hash',
    ])
    .where('status', 'in', ACTIVE_STATUSES)
    .where(
      sql<boolean>`coalesce(heartbeat_at, started_at, created_at) < now() - make_interval(secs => ${staleTimeoutS})`,
    )
    .execute();

  const result: ReconcileResult = { lost: 0, retried: 0, failed: 0 };

  for (const candidate of candidates) {
    try {
      await db.transaction().execute(async (trx) => {
        // Guarded LOST transition — skip if another actor already moved it.
        const guarded = await trx
          .updateTable('job_executions')
          .set({
            status: 'LOST',
            finished_at: sql`now()`,
            error_code: 'EXECUTION_LOST',
            error_message: 'Execution lost: no heartbeat within timeout',
          })
          .where('id', '=', candidate.id)
          .where('status', 'in', ACTIVE_STATUSES)
          .executeTakeFirst();

        if (!guarded || guarded.numUpdatedRows === 0n) return;
        result.lost += 1;

        // Always audit the loss itself.
        await trx
          .insertInto('audit_logs')
          .values({
            actor_type: 'SYSTEM',
            actor_ref: 'scheduler',
            action_code: 'JOB_EXECUTION_LOST',
            resource_type_code: 'JOB_EXECUTION',
            resource_id: candidate.id,
            result: 'FAILURE',
            correlation_id: candidate.correlation_id,
            error_code: 'EXECUTION_LOST',
            metadata: { job_type: candidate.job_type, job_id: candidate.job_id },
          })
          .execute();

        // Benchmark evaluations: mark failed + finalise the parent run so it
        // never hangs in RUNNING because a worker died.
        if (candidate.job_type === 'BENCHMARK_EVALUATION') {
          const done = await finalizeBenchmarkOnLost(trx, candidate.job_id, candidate.correlation_id);
          if (done) result.failed += 1;
          return;
        }

        // Model conversions: the worker died mid-export; mark the conversion FAILED so
        // the model page never hangs in RUNNING. Guarded on RUNNING only — a queued
        // conversion has no worker heartbeat to lose and stays for a future worker.
        if (candidate.job_type === 'MODEL_CONVERSION') {
          const failedConv = await trx
            .updateTable('model_conversions')
            .set({
              status: 'FAILED',
              failure_code: 'EXECUTION_LOST',
              failure_message: 'Conversion execution lost: worker stopped heartbeating',
              finished_at: sql`now()`,
              row_version: sql`row_version + 1`,
            })
            .where('id', '=', candidate.job_id)
            .where('status', '=', 'RUNNING')
            .executeTakeFirst();
          if (failedConv && failedConv.numUpdatedRows !== 0n) {
            await trx.insertInto('audit_logs').values({
              actor_type: 'SYSTEM', actor_ref: 'scheduler', action_code: 'MODEL_CONVERSION_FAILED',
              resource_type_code: 'MODEL_CONVERSION', resource_id: candidate.job_id, result: 'FAILURE',
              correlation_id: candidate.correlation_id, error_code: 'EXECUTION_LOST',
              metadata: { job_type: candidate.job_type },
            }).execute();
            result.failed += 1;
          }
          return;
        }

        // Dataset scans: the worker died mid-scan. Fail the scan row so the Jobs card
        // stops showing a contradictory "lost (PENDING)" and the per-source
        // PENDING/RUNNING uniqueness constraint frees the dataset for a rescan. The
        // worker's own failure path marks the source dataset INVALID, but a lost scan
        // never ran — reset the source from SCANNING to REGISTERED instead, since the
        // folder may be perfectly fine and simply needs a rescan.
        if (candidate.job_type === 'DATASET_SCAN') {
          const failedScan = await trx
            .updateTable('source_dataset_scans')
            .set({
              status: 'FAILED',
              finished_at: sql`now()`,
              error_code: 'EXECUTION_LOST',
              error_message: 'Scan execution lost: worker stopped heartbeating',
            })
            .where('id', '=', candidate.job_id)
            .where('status', 'in', ['PENDING', 'RUNNING'])
            .executeTakeFirst();
          if (failedScan && failedScan.numUpdatedRows !== 0n) {
            await trx.insertInto('audit_logs').values({
              actor_type: 'SYSTEM', actor_ref: 'scheduler', action_code: 'DATASET_SCAN_FAILED',
              resource_type_code: 'SOURCE_DATASET_SCAN', resource_id: candidate.job_id, result: 'FAILURE',
              correlation_id: candidate.correlation_id, error_code: 'EXECUTION_LOST',
              metadata: { job_type: candidate.job_type },
            }).execute();
            const scanRow = await trx.selectFrom('source_dataset_scans')
              .select('source_dataset_id').where('id', '=', candidate.job_id).executeTakeFirst();
            if (scanRow) {
              await trx.updateTable('source_datasets')
                .set({ status: 'REGISTERED', updated_at: sql`now()` })
                .where('id', '=', scanRow.source_dataset_id)
                .where('status', '=', 'SCANNING')
                .where('latest_scan_id', '=', candidate.job_id)
                .execute();
            }
            result.failed += 1;
          }
          return;
        }

        // Dataset build / registered-dataset validation: fail the training dataset the
        // same way the worker's own failure path does (INVALID), so it can be resubmitted.
        if (candidate.job_type === 'DATASET_BUILD' || candidate.job_type === 'TRAINING_DATASET_SCAN') {
          const failedDs = await trx
            .updateTable('training_datasets')
            .set({
              status: 'INVALID',
              failure_code: 'EXECUTION_LOST',
              failure_message: 'Dataset job execution lost: worker stopped heartbeating',
              build_finished_at: sql`now()`,
            })
            .where('id', '=', candidate.job_id)
            .where('status', 'in', ['BUILDING', 'VALIDATING'])
            .executeTakeFirst();
          if (failedDs && failedDs.numUpdatedRows !== 0n) {
            await trx.insertInto('audit_logs').values({
              actor_type: 'SYSTEM', actor_ref: 'scheduler', action_code: 'TRAINING_DATASET_FAILED',
              resource_type_code: 'TRAINING_DATASET', resource_id: candidate.job_id, result: 'FAILURE',
              correlation_id: candidate.correlation_id, error_code: 'EXECUTION_LOST',
              metadata: { job_type: candidate.job_type },
            }).execute();
            result.failed += 1;
          }
          return;
        }

        // Model ingest: the worker died mid-ingest; fail the task so the model page
        // never hangs and the user can retry the ingest.
        if (candidate.job_type === 'MODEL_INGEST') {
          const failedIngest = await trx
            .updateTable('model_ingest_tasks')
            .set({
              status: 'FAILED',
              failure_code: 'EXECUTION_LOST',
              failure_message: 'Ingest execution lost: worker stopped heartbeating',
              finished_at: sql`now()`,
            })
            .where('id', '=', candidate.job_id)
            .where('status', 'not in', ['COMPLETED', 'FAILED', 'CANCELLED'])
            .executeTakeFirst();
          if (failedIngest && failedIngest.numUpdatedRows !== 0n) {
            await trx.insertInto('audit_logs').values({
              actor_type: 'SYSTEM', actor_ref: 'scheduler', action_code: 'MODEL_INGEST_FAILED',
              resource_type_code: 'MODEL_INGEST', resource_id: candidate.job_id, result: 'FAILURE',
              correlation_id: candidate.correlation_id, error_code: 'EXECUTION_LOST',
              metadata: { job_type: candidate.job_type },
            }).execute();
            result.failed += 1;
          }
          return;
        }

        // Other job types: LOST + audit only for now.
        if (candidate.job_type !== 'TRAINING') return;

        const jobRow = await trx.selectFrom('training_jobs').select('status')
          .where('id', '=', candidate.job_id).executeTakeFirst();

        if (jobRow?.status === 'STOPPING') {
          await trx.updateTable('training_jobs')
            .set({ status: 'STOPPED', finished_at: sql`now()`, stopped_at: sql`now()`,
                   row_version: sql`row_version + 1`, updated_at: sql`now()` })
            .where('id', '=', candidate.job_id).where('status', '=', 'STOPPING')
            .execute();
          await trx.insertInto('audit_logs').values({
            actor_type: 'SYSTEM', actor_ref: 'scheduler', action_code: 'TRAINING_JOB_STOPPED',
            resource_type_code: 'TRAINING_JOB', resource_id: candidate.job_id, result: 'SUCCESS',
            correlation_id: candidate.correlation_id, metadata: { from: 'STOPPING', to: 'STOPPED', reason: 'execution_lost_during_stop' },
          }).execute();
          result.failed += 1;
          return;
        }

        // A lost execution is a liveness failure (doc 11 §26.1: retriable).
        // Retry while attempts remain, otherwise fail the job.
        const willRetry = candidate.attempt_number < retry.maxTrainingAttempts;

        if (!willRetry) {
          await trx
            .updateTable('training_jobs')
            .set({
              status: 'FAILED',
              failure_stage: 'RECOVERY',
              failure_code: 'EXECUTION_LOST',
              failure_message: 'Execution lost (heartbeat timeout); retry attempts exhausted',
              finished_at: sql`now()`,
              row_version: sql`row_version + 1`,
              updated_at: sql`now()`,
            })
            .where('id', '=', candidate.job_id)
            .where('status', 'not in', TERMINAL_JOB_STATUSES)
            .execute();
          result.failed += 1;
          return;
        }

        // Requeue the job first (guarded): if it is already terminal (e.g. user
        // cancelled), do not create an orphan retry execution — the LOST mark stands.
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
          .where('id', '=', candidate.job_id)
          .where('status', 'not in', TERMINAL_JOB_STATUSES)
          .executeTakeFirst();

        if (!requeued || requeued.numUpdatedRows === 0n) {
          logger.info('lost execution not retried: job terminal', {
            executionId: candidate.id,
            jobId: candidate.job_id,
          });
          return;
        }

        // Backoff cap kept below the stale timeout so the freshly-ASSIGNED retry
        // execution is claimed before it could itself look stale.
        const cap = Math.max(5, staleTimeoutS - 30);
        const r = await dispatchTrainingRetry(trx, {
          jobId: candidate.job_id,
          correlationId: candidate.correlation_id,
          backoffBaseS: retry.backoffBaseS,
          backoffCapS: cap,
          reason: 'execution_lost',
          lostExecutionId: candidate.id,
        });

        result.retried += 1;
        logger.info('lost execution scheduled for retry', {
          jobId: candidate.job_id,
          lostExecutionId: candidate.id,
          newExecutionId: r.newExecutionId,
          nextAttempt: r.nextAttempt,
          backoffS: r.backoffS,
        });
      });
    } catch (err) {
      logger.warn('reconcile transaction failed', {
        executionId: candidate.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
