import { Inject, Injectable } from '@nestjs/common';
import { DB_PROVIDER } from '../database/database.module';
import { type Kysely, type Transaction } from 'kysely';
import type { Database, AuditActorType, AuditResult } from '@model-trainer/db';
import { RequestContextService } from '../common/request-context/request-context.service';
import { StructuredLoggerService } from '../common/logger/structured-logger.service';

export const SENSITIVE_KEYS = /password|hash|token|secret|authorization|cookie|presigned/i;

export interface AuditAppendParams {
  actorType: AuditActorType;
  actorUserId?: string | null;
  actorRef?: string | null;
  actionCode: string;
  resourceTypeCode: string;
  resourceId: string;
  result: AuditResult;
  correlationId?: string;
  parentAuditId?: number | null;
  beforeSnapshot?: Record<string, unknown> | null;
  afterSnapshot?: Record<string, unknown> | null;
  diff?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  relatedResources?: {
    resourceTypeCode: string;
    resourceId: string;
    relationCode?: string | null;
  }[];
  requestId?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  traceId?: string | null;
}

export interface TimelineItem {
  id: number;
  occurred_at: string;
  actor_type: AuditActorType;
  actor_user_id: string | null;
  actor_ref: string | null;
  action_code: string;
  resource_type_code: string;
  resource_id: string;
  result: AuditResult;
  correlation_id: string;
  parent_audit_id: number | null;
  error_code: string | null;
}

export interface TimelineResult {
  items: TimelineItem[];
  nextCursor: string | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new StructuredLoggerService();

  constructor(@Inject(DB_PROVIDER) private readonly db: Kysely<Database>) {}

  private redact(obj: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
    if (!obj) return null;
    return this.deepRedact(obj);
  }

  private deepRedact(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (SENSITIVE_KEYS.test(key)) continue;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = this.deepRedact(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  async append(
    params: AuditAppendParams,
    trx?: Transaction<Database>,
  ): Promise<number> {
    const ctx = RequestContextService.get();
    const runner = trx ?? this.db;

    const correlationId = params.correlationId ?? crypto.randomUUID();

    const insertResult = await runner
      .insertInto('audit_logs')
      .values({
        actor_type: params.actorType,
        actor_user_id: params.actorUserId ?? null,
        actor_ref: params.actorRef ?? null,
        action_code: params.actionCode,
        resource_type_code: params.resourceTypeCode,
        resource_id: params.resourceId,
        result: params.result,
        correlation_id: correlationId,
        parent_audit_id: params.parentAuditId ?? null,
        before_snapshot: this.redact(params.beforeSnapshot) as Record<string, unknown> | null,
        after_snapshot: this.redact(params.afterSnapshot) as Record<string, unknown> | null,
        diff: this.redact(params.diff) as Record<string, unknown> | null,
        metadata: (this.redact(params.metadata) ?? {}) as Record<string, unknown>,
        error_code: params.errorCode ?? null,
        error_message: params.errorMessage ?? null,
        request_id: params.requestId ?? ctx?.requestId ?? null,
        trace_id: params.traceId ?? null,
        ip_address: params.ipAddress ?? null,
        user_agent: params.userAgent ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const auditId = insertResult.id;

    if (params.relatedResources && params.relatedResources.length > 0) {
      await runner
        .insertInto('audit_related_resources')
        .values(
          params.relatedResources.map((r) => ({
            audit_log_id: auditId,
            resource_type_code: r.resourceTypeCode,
            resource_id: r.resourceId,
            relation_code: r.relationCode ?? null,
          })),
        )
        .execute();
    }

    return auditId;
  }

  async resourceTimeline(
    resourceTypeCode: string,
    resourceId: string,
    cursor?: number,
    size = 25,
  ): Promise<TimelineResult> {
    const limit = Math.min(size, 100);

    let query = this.db
      .selectFrom('audit_logs')
      .select([
        'id',
        'occurred_at',
        'actor_type',
        'actor_user_id',
        'actor_ref',
        'action_code',
        'resource_type_code',
        'resource_id',
        'result',
        'correlation_id',
        'parent_audit_id',
        'error_code',
      ])
      .where((eb) =>
        eb.or([
          eb.and([
            eb('audit_logs.resource_type_code', '=', resourceTypeCode),
            eb('audit_logs.resource_id', '=', resourceId),
          ]),
          eb('audit_logs.id', 'in', (sub) =>
            sub
              .selectFrom('audit_related_resources')
              .select('audit_log_id')
              .where('resource_type_code', '=', resourceTypeCode)
              .where('resource_id', '=', resourceId),
          ),
        ]),
      );

    if (cursor) {
      query = query.where('id', '<', cursor);
    }

    const items = await query
      .orderBy('occurred_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();

    const hasMore = items.length > limit;
    if (hasMore) items.pop();

    return {
      items,
      nextCursor: hasMore ? String(items[items.length - 1]?.id ?? '') : null,
    };
  }

  async getByCorrelation(correlationId: string): Promise<TimelineItem[]> {
    return this.db
      .selectFrom('audit_logs')
      .select([
        'id',
        'occurred_at',
        'actor_type',
        'actor_user_id',
        'actor_ref',
        'action_code',
        'resource_type_code',
        'resource_id',
        'result',
        'correlation_id',
        'parent_audit_id',
        'error_code',
      ])
      .where('correlation_id', '=', correlationId)
      .orderBy('occurred_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
  }
}
