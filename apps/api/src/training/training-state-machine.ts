import { Injectable, HttpException } from '@nestjs/common';
import { type Transaction, sql } from 'kysely';
import type { Database, TrainingJobStatus } from '@model-trainer/db';
import { errorCode } from '@model-trainer/shared-types';
import { AuditService } from '../audit/audit.service';

const err = (code: string, message: string, status: number) =>
  new HttpException({ error: { code, message, requestId: '' } }, status);

// Legal transitions (doc 08 §15). No DRAFT — job creation is create+submit,
// so a job enters the machine at QUEUED or BLOCKED.
const LEGAL: Record<TrainingJobStatus, TrainingJobStatus[]> = {
  SCHEDULED: ['QUEUED', 'BLOCKED', 'CANCELLED'],
  BLOCKED: ['QUEUED', 'FAILED', 'CANCELLED'],
  QUEUED: ['PREPARING', 'CANCELLED', 'FAILED'],
  PREPARING: ['RUNNING', 'CANCELLED', 'FAILED'],
  RUNNING: ['STOPPING', 'COMPLETED', 'FAILED'],
  STOPPING: ['STOPPED', 'FAILED'],
  // Terminal -> QUEUED/BLOCKED only via retry() (in-place restart, same job id, new
  // job_executions attempt). Never a worker/system transition.
  COMPLETED: ['QUEUED', 'BLOCKED'],
  FAILED: ['QUEUED', 'BLOCKED'],
  CANCELLED: ['QUEUED', 'BLOCKED'],
  STOPPED: ['QUEUED', 'BLOCKED'],
};

const TIMESTAMP_FOR: Partial<Record<TrainingJobStatus, string>> = {
  QUEUED: 'queued_at', PREPARING: 'preparing_at', RUNNING: 'started_at',
  COMPLETED: 'finished_at', FAILED: 'finished_at', STOPPED: 'stopped_at',
  CANCELLED: 'cancelled_at', STOPPING: 'stop_requested_at',
};

export const TERMINAL: TrainingJobStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'STOPPED'];

export interface TransitionInput {
  jobId: string;
  to: TrainingJobStatus;
  actorType: 'USER' | 'WORKER' | 'SYSTEM';
  actorUserId?: string | null;
  actorRef?: string;
  correlationId: string;
  failure?: { stage: string; code: string; message: string };
  extraSet?: Record<string, unknown>;
  auditAction: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class TrainingStateMachine {
  constructor(private readonly auditService: AuditService) {}

  /** Central, guarded status transition. Locks the row, validates, stamps time, bumps row_version, audits. */
  async transition(trx: Transaction<Database>, input: TransitionInput) {
    const job = await trx.selectFrom('training_jobs').selectAll().where('id', '=', input.jobId).forUpdate().executeTakeFirst();
    if (!job) throw err(errorCode.TRAINING_JOB_NOT_FOUND, 'training job not found', 404);
    const from = job.status as TrainingJobStatus;
    if (!LEGAL[from].includes(input.to)) {
      throw err(errorCode.TRAINING_INVALID_TRANSITION, `illegal transition ${from} -> ${input.to}`, 409);
    }

    const set: Record<string, unknown> = {
      status: input.to, row_version: job.row_version + 1, updated_at: sql`now()`, ...(input.extraSet ?? {}),
    };
    const tsCol = TIMESTAMP_FOR[input.to];
    if (tsCol && !(tsCol in set)) set[tsCol] = sql`now()`;
    if (input.failure) {
      set.failure_stage = input.failure.stage;
      set.failure_code = input.failure.code;
      set.failure_message = input.failure.message.slice(0, 1000);
    }
    await trx.updateTable('training_jobs').set(set as never).where('id', '=', input.jobId).execute();

    await this.auditService.append({
      actorType: input.actorType, actorUserId: input.actorUserId ?? null, actorRef: input.actorRef,
      actionCode: input.auditAction, resourceTypeCode: 'TRAINING_JOB', resourceId: input.jobId,
      result: input.failure ? 'FAILURE' : 'SUCCESS', correlationId: input.correlationId,
      metadata: { from, to: input.to, ...(input.metadata ?? {}) },
      errorCode: input.failure?.code, errorMessage: input.failure?.message,
    }, trx);

    return { from, to: input.to };
  }
}
