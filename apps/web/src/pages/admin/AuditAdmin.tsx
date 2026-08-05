import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { apiGet, apiGetList } from '../../lib/api';
import { StatusBadge } from '../../components/StatusBadge';
import { SkeletonLoader } from '../../components/SkeletonLoader';
import { EmptyState } from '../../components/EmptyState';
import { InfiniteSentinel } from '../../components/InfiniteSentinel';
import { formatDate } from '../../lib/format';
import { Modal } from '../../components/Modal';
import { Select } from '../../components/Select';

interface AuditRow {
  id: number;
  occurred_at: string;
  actor_type: string;
  actor_user_id: string | null;
  actor_ref: string | null;
  actor_username: string | null;
  action_code: string;
  resource_type_code: string;
  resource_id: string;
  result: 'SUCCESS' | 'FAILURE';
  correlation_id: string;
  parent_audit_id: number | null;
  error_code: string | null;
}

interface AuditDetail extends AuditRow {
  before_snapshot: unknown;
  after_snapshot: unknown;
  diff: unknown;
  metadata: unknown;
  error_message: string | null;
  request_id: string | null;
  trace_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
}

const ACTOR_TYPES = ['USER', 'WORKER', 'SCHEDULER', 'SYSTEM', 'API'] as const;
const RESULTS = ['SUCCESS', 'FAILURE'] as const;
const SIZE = 25;

const ACTION_LABELS: Record<string, string> = {
  AUTH_LOGIN_SUCCEEDED: 'Login succeeded',
  AUTH_LOGIN_FAILED: 'Login failed',
  AUTH_LOGOUT: 'Logged out',
  USER_CREATED: 'User created',
  USER_UPDATED: 'User updated',
  USER_ENABLED: 'User enabled',
  USER_DISABLED: 'User disabled',
  DATASET_TYPE_CREATED: 'Dataset type created',
  DATASET_TYPE_UPDATED: 'Dataset type updated',
  DATASET_TYPE_PATH_CHANGED: 'Dataset type path changed',
  DATASET_TYPE_ENABLED: 'Dataset type enabled',
  DATASET_TYPE_DISABLED: 'Dataset type disabled',
  DATASET_TYPE_DELETED: 'Dataset type deleted',
  DATASET_TYPE_RESCAN_REQUESTED: 'Dataset type rescan requested',
  SOURCE_DATASET_CREATED: 'Source dataset registered',
  SOURCE_DATASET_RESCAN_REQUESTED: 'Source dataset rescan requested',
  DATASET_SCAN_FAILED: 'Source dataset scan failed',
  TRAINING_DATASET_CREATED: 'Training dataset created',
  TRAINING_DATASET_VALIDATION_SUBMITTED: 'Training dataset validation submitted',
  TRAINING_DATASET_BUILD_SUBMITTED: 'Training dataset build submitted',
  TRAINING_DATASET_BUILD_CONFIGURED: 'Training dataset build configured',
  TRAINING_DATASET_BUILD_COMPLETED: 'Training dataset build completed',
  TRAINING_DATASET_BUILD_FAILED: 'Training dataset build failed',
  TRAINING_DATASET_SCANNED: 'Training dataset scanned',
  TRAINING_DATASET_SCAN_FAILED: 'Training dataset scan failed',
  MODEL_SCAN_REQUESTED: 'Model scan requested',
  MODEL_SCAN_COMPLETED: 'Model scan completed',
  MODEL_DISCOVERED: 'Model discovered',
  MODEL_METADATA_BACKFILLED: 'Model metadata backfilled',
  MODEL_CREATED: 'Model created',
  MODEL_INGEST_REQUESTED: 'Model ingest requested',
  MODEL_INGEST_FAILED: 'Model ingest failed',
  TRAINING_DRAFT_CREATED: 'Training draft created',
  TRAINING_DRAFT_UPDATED: 'Training draft updated',
  TRAINING_JOB_SUBMITTED: 'Training job submitted',
  TRAINING_JOB_PREPARING: 'Training job preparing',
  TRAINING_JOB_RUNNING: 'Training job running',
  TRAINING_JOB_COMPLETED: 'Training job completed',
  TRAINING_JOB_FAILED: 'Training job failed',
  TRAINING_JOB_STOPPED: 'Training job stopped',
  TRAINING_JOB_STOP_REQUESTED: 'Training stop requested',
  TRAINING_JOB_CANCELLED: 'Training job cancelled',
  TRAINING_JOB_UNBLOCKED: 'Training job unblocked',
  TRAINING_JOB_RETRY_SCHEDULED: 'Training retry scheduled',
  JOB_EXECUTION_LOST: 'Job execution lost',
  BENCHMARK_DRAFT_CREATED: 'Benchmark draft created',
  BENCHMARK_SUBMITTED: 'Benchmark run submitted',
  BENCHMARK_EVALUATION_COMPLETED: 'Benchmark evaluation completed',
  BENCHMARK_EVALUATION_FAILED: 'Benchmark evaluation failed',
  BENCHMARK_RUN_FINISHED: 'Benchmark run finished',
  SYSTEM_SETTING_UPDATED: 'System setting updated',
  ADMIN_DATA_EXPORTED: 'Admin data exported',
  ADMIN_DATA_IMPORTED: 'Admin data imported',
};

function actionLabel(code: string): string {
  return ACTION_LABELS[code] ?? code;
}

type Filters = {
  actionCode: string;
  resourceType: string;
  result: string;
  actorType: string;
  from: string;
  to: string;
};

const EMPTY_FILTERS: Filters = {
  actionCode: '',
  resourceType: '',
  result: '',
  actorType: '',
  from: '',
  to: '',
};

function actorLabel(r: {
  actor_username: string | null;
  actor_ref: string | null;
  actor_type: string;
}): string {
  return r.actor_username || r.actor_ref || r.actor_type;
}

function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : '—';
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value == null) return null;
  return (
    <div className="field">
      <span>{label}</span>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <span>{label}</span>
      <div>{children}</div>
    </div>
  );
}

export function AuditAdmin() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [correlationId, setCorrelationId] = useState<string | null>(null);

  const filterParams = useMemo(() => {
    const p = new URLSearchParams();
    if (filters.actionCode) p.set('actionCode', filters.actionCode);
    if (filters.resourceType) p.set('resourceType', filters.resourceType);
    if (filters.result) p.set('result', filters.result);
    if (filters.actorType) p.set('actorType', filters.actorType);
    if (filters.from) p.set('from', new Date(filters.from).toISOString());
    if (filters.to) p.set('to', new Date(filters.to).toISOString());
    return p;
  }, [filters]);

  function exportCsv() {
    const a = document.createElement('a');
    a.href = `/api/v1/admin/audit/export?${filterParams.toString()}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const list = useInfiniteQuery({
    queryKey: ['admin-audit', filters],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(filterParams);
      p.set('page', String(pageParam));
      p.set('size', String(SIZE));
      return apiGetList<AuditRow>(`/admin/audit?${p.toString()}`);
    },
    initialPageParam: 1,
    getNextPageParam: (last) => (last.meta.page < last.meta.totalPages ? last.meta.page + 1 : undefined),
  });

  const detail = useQuery({
    queryKey: ['admin-audit-detail', selectedId],
    queryFn: () => apiGet<AuditDetail>(`/admin/audit/${selectedId}`),
    enabled: selectedId != null,
  });

  const correlation = useQuery({
    queryKey: ['admin-audit-corr', correlationId],
    queryFn: () => apiGet<AuditRow[]>(`/admin/audit/correlation/${correlationId}`),
    enabled: !!correlationId,
  });

  function setFilter(key: keyof Filters, value: string) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  const meta = list.data?.pages[0]?.meta;
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  const activeCount = Object.values(filters).filter((v) => v !== '').length;

  return (
    <section className="page">
      <header className="page-head">
        <h2>Audit Log</h2>
      </header>

      <div className="filter-bar">
        <div className="filter-grid">
          <label className="field">
            <span>Action</span>
            <input
              value={filters.actionCode}
              onChange={(e) => setFilter('actionCode', e.target.value)}
              placeholder="e.g. user.create"
            />
          </label>
          <label className="field">
            <span>Resource type</span>
            <input
              value={filters.resourceType}
              onChange={(e) => setFilter('resourceType', e.target.value)}
              placeholder="e.g. DATASET_TYPE"
            />
          </label>
          <label className="field">
            <span>Result</span>
            <Select
              value={filters.result}
              onChange={(v) => setFilter('result', v)}
              options={[{ value: '', label: 'Any' }, ...RESULTS.map((r) => ({ value: r, label: r }))]}
            />
          </label>
          <label className="field">
            <span>Actor type</span>
            <Select
              value={filters.actorType}
              onChange={(v) => setFilter('actorType', v)}
              options={[{ value: '', label: 'Any' }, ...ACTOR_TYPES.map((t) => ({ value: t, label: t }))]}
            />
          </label>
          <label className="field">
            <span>From</span>
            <input
              type="datetime-local"
              value={filters.from}
              onChange={(e) => setFilter('from', e.target.value)}
            />
          </label>
          <label className="field">
            <span>To</span>
            <input
              type="datetime-local"
              value={filters.to}
              onChange={(e) => setFilter('to', e.target.value)}
            />
          </label>
        </div>

        <div className="filter-actions">
          <span className="filter-summary">
            {activeCount === 0
              ? 'No filters applied'
              : `${activeCount} filter${activeCount === 1 ? '' : 's'} applied`}
            {meta ? ` · ${meta.total} entr${meta.total === 1 ? 'y' : 'ies'}` : ''}
          </span>
          <div className="spacer" />
          <button
            className="btn btn-sm btn-ghost"
            disabled={activeCount === 0}
            onClick={() => {
              setFilters(EMPTY_FILTERS);
            }}
          >
            Reset
          </button>
          <button className="btn btn-sm" onClick={exportCsv}>
            Export CSV
          </button>
        </div>
      </div>

      {list.isLoading && <SkeletonLoader rows={5} cols={5} />}
      {list.error && <EmptyState type="error" message={(list.error as Error).message} />}
      {rows.length === 0 && !list.isLoading && !list.error && <EmptyState message="No audit entries." />}

      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Resource</th>
                <th>Result</th>
                <th className="audit-corr-col">Correlation</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => setSelectedId(r.id)}>
                  <td>{formatDate(r.occurred_at)}</td>
                  <td>{actorLabel(r)}</td>
                  <td>
                    <div className="cell-title">{actionLabel(r.action_code)}</div>
                    {actionLabel(r.action_code) !== r.action_code && (
                      <div className="cell-sub">{r.action_code}</div>
                    )}
                  </td>
                  <td>
                    {r.resource_type_code} {shortId(r.resource_id)}
                  </td>
                  <td>
                    <StatusBadge status={r.result} />
                  </td>
                  <td className="audit-corr-col">
                    <button
                      className="btn btn-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setCorrelationId(r.correlation_id);
                      }}
                    >
                      {shortId(r.correlation_id)}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && (
        <InfiniteSentinel
          hasNextPage={list.hasNextPage === true}
          isFetchingNextPage={list.isFetchingNextPage}
          onLoadMore={() => list.fetchNextPage()}
        />
      )}

      {selectedId != null && (
        <Modal title="Audit Detail" onClose={() => setSelectedId(null)}>
          {detail.isLoading && <SkeletonLoader rows={5} cols={2} />}
          {detail.error && (
            <EmptyState type="error" message={(detail.error as Error).message} />
          )}
          {detail.data && (
            <>
              <Field label="Time">{formatDate(detail.data.occurred_at)}</Field>
              <Field label="Actor">{actorLabel(detail.data)}</Field>
              <Field label="Action">
                {actionLabel(detail.data.action_code)}
                {actionLabel(detail.data.action_code) !== detail.data.action_code && (
                  <code> · {detail.data.action_code}</code>
                )}
              </Field>
              <Field label="Resource">
                {detail.data.resource_type_code} {detail.data.resource_id}
              </Field>
              <Field label="Result">
                <StatusBadge status={detail.data.result} />
              </Field>
              <Field label="Correlation ID">{detail.data.correlation_id}</Field>
              <Field label="Parent audit ID">{detail.data.parent_audit_id ?? '—'}</Field>
              <Field label="Error code">{detail.data.error_code ?? '—'}</Field>
              {detail.data.error_message && (
                <Field label="Error message">{detail.data.error_message}</Field>
              )}
              <JsonBlock label="Before snapshot" value={detail.data.before_snapshot} />
              <JsonBlock label="After snapshot" value={detail.data.after_snapshot} />
              <JsonBlock label="Diff" value={detail.data.diff} />
              <JsonBlock label="Metadata" value={detail.data.metadata} />
            </>
          )}
        </Modal>
      )}

      {correlationId && (
        <Modal title={`Correlation ${shortId(correlationId)}`} onClose={() => setCorrelationId(null)}>
          {correlation.isLoading && <SkeletonLoader rows={5} cols={4} />}
          {correlation.error && (
            <EmptyState type="error" message={(correlation.error as Error).message} />
          )}
          {correlation.data && correlation.data.length === 0 && (
            <EmptyState message="No entries." />
          )}
          {correlation.data && correlation.data.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Action</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {correlation.data.map((r) => (
                    <tr key={r.id}>
                      <td>{formatDate(r.occurred_at)}</td>
                      <td>{r.action_code}</td>
                      <td>
                        <StatusBadge status={r.result} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
    </section>
  );
}
