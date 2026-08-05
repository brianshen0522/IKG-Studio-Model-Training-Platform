import { Inject, Injectable, HttpException } from '@nestjs/common';
import { DB_PROVIDER } from '../database/database.module';
import { type Kysely, sql } from 'kysely';
import type { Database, AuditActorType, AuditResult } from '@model-trainer/db';
import { errorCode } from '@model-trainer/shared-types';
import { SENSITIVE_KEYS } from './audit.service';

export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

function redactRow<T extends Record<string, unknown>>(row: T): T {
  return {
    ...row,
    before_snapshot: redact(row.before_snapshot),
    after_snapshot: redact(row.after_snapshot),
    diff: redact(row.diff),
    metadata: redact(row.metadata),
  };
}

const LIST_COLUMNS = [
  'al.id',
  'al.occurred_at',
  'al.actor_type',
  'al.actor_user_id',
  'al.actor_ref',
  'al.action_code',
  'al.resource_type_code',
  'al.resource_id',
  'al.result',
  'al.correlation_id',
  'al.parent_audit_id',
  'al.error_code',
] as const;

// CSV export columns (scalar, non-sensitive only — never snapshots/metadata).
const CSV_COLUMNS = [
  'id',
  'occurred_at',
  'actor_type',
  'actor_username',
  'actor_ref',
  'action_code',
  'resource_type_code',
  'resource_id',
  'result',
  'correlation_id',
  'error_code',
] as const;
const EXPORT_MAX_ROWS = 10000;

export interface AuditFilterParams {
  actorType?: AuditActorType;
  actorUserId?: string;
  actionCode?: string;
  resourceType?: string;
  resourceId?: string;
  result?: AuditResult;
  correlationId?: string;
  from?: string;
  to?: string;
}

interface ListParams extends AuditFilterParams {
  page: number;
  size: number;
}

function parseTimestamp(v?: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

@Injectable()
export class AdminAuditService {
  constructor(@Inject(DB_PROVIDER) private readonly db: Kysely<Database>) {}

  /** Base query with the shared filter set applied (references al.* columns only). */
  private filtered(params: AuditFilterParams) {
    let q = this.db.selectFrom('audit_logs as al');
    if (params.actorType) q = q.where('al.actor_type', '=', params.actorType);
    if (params.actorUserId) q = q.where('al.actor_user_id', '=', params.actorUserId);
    if (params.actionCode) q = q.where('al.action_code', '=', params.actionCode);
    if (params.resourceType) q = q.where('al.resource_type_code', '=', params.resourceType);
    if (params.resourceId) q = q.where('al.resource_id', '=', params.resourceId);
    if (params.result) q = q.where('al.result', '=', params.result);
    if (params.correlationId) q = q.where('al.correlation_id', '=', params.correlationId);
    const fromTs = parseTimestamp(params.from);
    if (fromTs) q = q.where('al.occurred_at', '>=', fromTs);
    const toTs = parseTimestamp(params.to);
    if (toTs) q = q.where('al.occurred_at', '<=', toTs);
    return q;
  }

  async list(params: ListParams) {
    const size = Math.min(Math.max(params.size, 1), 100);
    const offset = (params.page - 1) * size;

    const [{ count }] = await this.filtered(params).select(sql<number>`count(*)`.as('count')).execute();

    const items = await this.filtered(params)
      .leftJoin('users as u', 'u.id', 'al.actor_user_id')
      .select([...LIST_COLUMNS, 'u.username as actor_username'])
      .orderBy('al.occurred_at', 'desc')
      .orderBy('al.id', 'desc')
      .limit(size)
      .offset(offset)
      .execute();

    return { items, total: Number(count), page: params.page, size };
  }

  async exportCsv(params: AuditFilterParams): Promise<string> {
    const rows = await this.filtered(params)
      .leftJoin('users as u', 'u.id', 'al.actor_user_id')
      .select([...LIST_COLUMNS, 'u.username as actor_username'])
      .orderBy('al.occurred_at', 'desc')
      .orderBy('al.id', 'desc')
      .limit(EXPORT_MAX_ROWS)
      .execute();

    const lines = [CSV_COLUMNS.join(',')];
    for (const r of rows) {
      lines.push(CSV_COLUMNS.map((c) => csvEscape((r as Record<string, unknown>)[c])).join(','));
    }
    return lines.join('\n');
  }

  async getDetail(auditId: string) {
    const id = Number(auditId);
    if (!Number.isInteger(id)) {
      throw new HttpException(
        { error: { code: errorCode.VALIDATION_FAILED, message: 'auditId must be an integer', requestId: '' } },
        400,
      );
    }

    const row = await this.db
      .selectFrom('audit_logs as al')
      .leftJoin('users as u', 'u.id', 'al.actor_user_id')
      .selectAll('al')
      .select('u.username as actor_username')
      .where('al.id', '=', id)
      .executeTakeFirst();

    if (!row) {
      throw new HttpException(
        { error: { code: errorCode.RESOURCE_NOT_FOUND, message: 'Audit log not found', requestId: '' } },
        404,
      );
    }

    return redactRow(row);
  }

  async getByCorrelation(correlationId: string) {
    const rows = await this.db
      .selectFrom('audit_logs as al')
      .leftJoin('users as u', 'u.id', 'al.actor_user_id')
      .selectAll('al')
      .select('u.username as actor_username')
      .where('al.correlation_id', '=', correlationId)
      .orderBy('al.occurred_at', 'asc')
      .orderBy('al.id', 'asc')
      .execute();

    return rows.map(redactRow);
  }

  /** Timeline of audit entries for one resource (doc 13 §17 history), oldest first. */
  async historyForResource(resourceTypeCode: string, resourceId: string) {
    const rows = await this.db
      .selectFrom('audit_logs as al')
      .leftJoin('users as u', 'u.id', 'al.actor_user_id')
      .selectAll('al')
      .select('u.username as actor_username')
      .where('al.resource_type_code', '=', resourceTypeCode)
      .where('al.resource_id', '=', resourceId)
      .orderBy('al.occurred_at', 'asc')
      .orderBy('al.id', 'asc')
      .execute();

    return rows.map(redactRow);
  }
}
