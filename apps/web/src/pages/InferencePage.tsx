import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGetList } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { EmptyState } from '../components/EmptyState';
import { NewInferenceRunDialog } from '../components/NewInferenceRunDialog';
import { SearchableSelect, type SelectOption } from '../components/SearchableSelect';
import { formatDate, formatElapsed, formatShare } from '../lib/format';
import { useUrlParam } from '../lib/urlState';
import { InferenceRunDetail } from './InferenceRunDetail';
import { InferenceRunActions } from '../components/InferenceRunActions';

interface InferenceRun {
  id: string;
  created_by_user_id: string;
  name: string;
  description: string | null;
  status: string;
  model_name: string | null;
  dataset_type_id: string;
  dataset_type_name: string | null;
  source_dataset_names: string[];
  run_dataset_ids: string[];
  dataset_count: number;
  completed_count: number;
  failed_count: number;
  diff_image_count: number;
  image_count: number;
  processed_count: number;
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

const ACTIVE = new Set(['QUEUED', 'RUNNING', 'STOPPING']);

/** Above this share of differing images the model probably does not fit the data. */
const HIGH_DIFF = 0.5;

export function InferencePage() {
  const [showNew, setShowNew] = useState(false);
  const [selectedId, setSelectedId] = useUrlParam('inferenceRunId');
  const [, setCompareId] = useUrlParam('compareDatasetId');
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

  // Straight to the compare page of a one-dataset run: the run page would
  // only be a click on the way there.
  const openCompare = (runId: string, rdId: string) => {
    setCompareId(rdId);
    setSelectedId(runId);
  };

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

      <div className="inference-filters">
        <input
          type="text"
          className="inference-search"
          placeholder="🔍 Search by name, model or dataset..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <SearchableSelect
          label=""
          options={STATUS_OPTIONS}
          value={statusFilter}
          onChange={setStatusFilter}
          placeholder="All statuses"
          style={{ minWidth: '170px' }}
        />
      </div>

      {isLoading && <SkeletonLoader rows={5} variant="list" />}
      {error && <EmptyState type="error" message={(error as Error).message} />}
      {data && filtered.length === 0 && (
        <EmptyState message={runs.length === 0 ? 'No inference runs yet.' : 'No inference runs match your filters.'} />
      )}

      {data && filtered.length > 0 && (
        <div className="inference-list">
          {filtered.map((r) => {
            const active = ACTIVE.has(r.status);
            const share = r.processed_count ? r.diff_image_count / r.processed_count : 0;
            const high = !active && r.processed_count > 0 && share >= HIGH_DIFF;
            const progress = r.image_count ? r.processed_count / r.image_count : 0;
            const single = r.run_dataset_ids.length === 1 && r.diff_image_count > 0;
            return (
              <div key={r.id} className="inference-card" onClick={() => setSelectedId(r.id)}>
                <div className="inference-card-main">
                  <div className="inference-card-title">
                    <span className="inference-card-name">{r.name}</span>
                    {r.dataset_type_name && <span className="inference-chip">{r.dataset_type_name}</span>}
                  </div>
                  {r.description && <div className="inference-card-desc">{r.description}</div>}
                  <div className="inference-card-route">
                    <span className="inference-model" title="Model">{r.model_name ?? '—'}</span>
                    <span className="inference-arrow">→</span>
                    {r.source_dataset_names.slice(0, 3).map((n) => (
                      <span key={n} className="inference-dataset" title="Source dataset">{n}</span>
                    ))}
                    {r.source_dataset_names.length > 3 && (
                      <span className="inference-more">+{r.source_dataset_names.length - 3} more</span>
                    )}
                  </div>
                </div>

                <div className="inference-card-metric">
                  {active ? (
                    <>
                      <div className="inference-metric-line">
                        <span>
                          {r.status === 'QUEUED' ? 'Waiting for a worker' : `${r.processed_count.toLocaleString()} / ${r.image_count.toLocaleString()} images`}
                        </span>
                        <strong>{formatShare(r.processed_count, r.image_count)}</strong>
                      </div>
                      <div className="inference-bar"><div style={{ width: `${progress * 100}%`, background: 'var(--primary)' }} /></div>
                    </>
                  ) : (
                    <>
                      <div className="inference-metric-line">
                        <span>
                          <strong style={{ color: 'var(--text)' }}>{r.diff_image_count.toLocaleString()}</strong>
                          {' '}of {r.processed_count.toLocaleString()} images differ
                        </span>
                        <strong style={{ color: high ? 'var(--yellow)' : 'var(--text)' }}>
                          {formatShare(r.diff_image_count, r.processed_count)}
                        </strong>
                      </div>
                      <div className="inference-bar">
                        <div style={{ width: `${share * 100}%`, background: high ? 'var(--yellow)' : 'var(--primary)' }} />
                      </div>
                      {high && <div className="inference-metric-hint">Model disagrees with most labels</div>}
                      {r.failed_count > 0 && (
                        <div className="inference-metric-hint" style={{ color: 'var(--red)' }}>
                          {r.failed_count} of {r.dataset_count} datasets failed
                        </div>
                      )}
                    </>
                  )}
                </div>

                <div className="inference-card-side">
                  <StatusBadge status={r.status} />
                  <div className="inference-card-time" title={`Created ${formatDate(r.created_at)}`}>
                    {formatDate(r.created_at)}
                    {r.finished_at && ` · ${formatElapsed(r.created_at, r.finished_at)}`}
                  </div>
                  <div className="inference-card-actions" onClick={(e) => e.stopPropagation()}>
                    {single && (
                      <button className="btn btn-sm btn-primary" onClick={() => openCompare(r.id, r.run_dataset_ids[0])}>
                        Compare
                      </button>
                    )}
                    <InferenceRunActions run={r} />
                  </div>
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
