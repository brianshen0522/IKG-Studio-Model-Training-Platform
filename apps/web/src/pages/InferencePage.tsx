import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGetList } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { EmptyState } from '../components/EmptyState';
import { NewInferenceRunDialog } from '../components/NewInferenceRunDialog';
import { SearchableSelect, type SelectOption } from '../components/SearchableSelect';
import { formatDate } from '../lib/format';
import { useUrlParam } from '../lib/urlState';
import { InferenceRunDetail } from './InferenceRunDetail';
import { InferenceRunActions } from '../components/InferenceRunActions';

interface InferenceRun {
  id: string;
  name: string;
  description: string | null;
  status: string;
  model_name: string | null;
  dataset_type_id: string;
  dataset_type_name: string | null;
  source_dataset_names: string[];
  dataset_count: number;
  completed_count: number;
  failed_count: number;
  diff_image_count: number;
  created_at: string;
  finished_at: string | null;
}

const STATUS_OPTIONS: SelectOption[] = [
  { value: 'QUEUED', label: 'Queued' },
  { value: 'RUNNING', label: 'Running' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'PARTIALLY_FAILED', label: 'Partially Failed' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'STOPPED', label: 'Stopped' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

export function InferencePage() {
  const [showNew, setShowNew] = useState(false);
  const [selectedId, setSelectedId] = useUrlParam('inferenceRunId');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['inference-runs'],
    refetchInterval: 5000,
    queryFn: () => apiGetList<InferenceRun>('/inference-runs?size=200'),
  });
  const runs = data?.data ?? [];

  const filtered = useMemo(() => runs.filter((r) => {
    if (statusFilter && r.status !== statusFilter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return r.name.toLowerCase().includes(q)
      || (r.description ?? '').toLowerCase().includes(q)
      || (r.model_name ?? '').toLowerCase().includes(q)
      || r.source_dataset_names.some((n) => n.toLowerCase().includes(q));
  }), [runs, search, statusFilter]);

  if (selectedId) return <InferenceRunDetail id={selectedId} onBack={() => setSelectedId(null)} />;

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h2 style={{ margin: 0 }}>Inference</h2>
            {data && <span className="count">{data.meta.total} total</span>}
          </div>
          <p style={{ margin: '4px 0 0 0', color: 'var(--text-sub)', fontSize: '13px' }}>
            Re-infer source datasets with a model and find the images whose labels disagree
          </p>
        </div>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New Inference Run</button>
      </header>

      <div
        style={{
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
          padding: '12px 16px', marginBottom: '20px', display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap',
        }}
      >
        <input
          type="text"
          placeholder="🔍 Search by name, model or dataset..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: 2, minWidth: '200px', padding: '7px 12px', fontSize: '13px', background: 'var(--bg)',
            color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
          }}
        />
        <SearchableSelect
          label="Status"
          options={STATUS_OPTIONS}
          value={statusFilter}
          onChange={setStatusFilter}
          placeholder="All Statuses"
          style={{ flex: 1, minWidth: '140px' }}
        />
      </div>

      {isLoading && <SkeletonLoader rows={5} variant="list" />}
      {error && <EmptyState type="error" message={(error as Error).message} />}
      {data && filtered.length === 0 && (
        <EmptyState message={runs.length === 0 ? 'No inference runs yet.' : 'No inference runs match your filters.'} />
      )}

      {data && filtered.length > 0 && (
        <div className="job-list">
          {filtered.map((r) => {
            const done = r.completed_count + r.failed_count;
            const pct = r.dataset_count > 0 ? Math.round((done / r.dataset_count) * 100) : 0;
            return (
              <div key={r.id} className="job-card" onClick={() => setSelectedId(r.id)} style={{ cursor: 'pointer' }}>
                <div className="job-card-body">
                  <div className="job-card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span className="job-card-name" style={{ fontWeight: 600, fontSize: '15px', color: 'var(--text)' }}>{r.name}</span>
                        {r.dataset_type_name && (
                          <span style={{ fontSize: '11px', background: 'var(--surface-muted)', color: 'var(--text-sub)', padding: '2px 8px', borderRadius: '10px', border: '1px solid var(--border)' }}>
                            {r.dataset_type_name}
                          </span>
                        )}
                      </div>
                      {r.description && (
                        <div style={{ fontSize: '12px', color: 'var(--text-sub)', marginTop: '4px' }}>{r.description}</div>
                      )}
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
                        {r.model_name && (
                          <span style={{ fontSize: '10px', color: 'var(--blue)', background: 'var(--blue-glow)', padding: '1px 6px', borderRadius: '4px' }}>
                            {r.model_name}
                          </span>
                        )}
                        {r.source_dataset_names.slice(0, 3).map((n, i) => (
                          <span key={i} style={{ fontSize: '10px', color: 'var(--green)', background: 'rgba(32,194,90,0.12)', padding: '1px 6px', borderRadius: '4px' }}>
                            {n}
                          </span>
                        ))}
                        {r.source_dataset_names.length > 3 && (
                          <span style={{ fontSize: '10px', color: 'var(--text-sub)' }}>+{r.source_dataset_names.length - 3} more</span>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <StatusBadge status={r.status} />
                      <InferenceRunActions run={r} />
                    </div>
                  </div>

                  <div style={{ marginTop: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-sub)', marginBottom: '4px' }}>
                      <span>
                        {r.completed_count} / {r.dataset_count} datasets done
                        {r.failed_count > 0 ? ` (${r.failed_count} failed)` : ''}
                        {' · '}
                        <strong style={{ color: 'var(--text)' }}>{r.diff_image_count.toLocaleString()}</strong> images differ
                      </span>
                      <span style={{ fontWeight: 600, color: 'var(--text)' }}>{pct}%</span>
                    </div>
                    <div style={{ height: '7px', width: '100%', backgroundColor: 'var(--surface-muted)', borderRadius: '4px', overflow: 'hidden' }}>
                      <div
                        style={{
                          height: '100%', width: `${pct}%`, transition: 'width 0.3s ease',
                          backgroundColor: r.failed_count > 0 ? 'var(--yellow)' : 'var(--primary)',
                        }}
                      />
                    </div>
                  </div>
                </div>
                <div className="job-card-meta" style={{ display: 'flex', gap: '16px', fontSize: '12px', color: 'var(--text-sub)', borderTop: '1px solid var(--border)', paddingTop: '10px', marginTop: '12px' }}>
                  <span>Created: {formatDate(r.created_at)}</span>
                  {r.finished_at && <span>Finished: {formatDate(r.finished_at)}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showNew && <NewInferenceRunDialog onClose={() => setShowNew(false)} />}
    </section>
  );
}
