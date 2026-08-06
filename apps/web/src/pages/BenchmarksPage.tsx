import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGetList } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { EmptyState } from '../components/EmptyState';
import { NewBenchmarkRunDialog } from '../components/NewBenchmarkRunDialog';
import { CompareModelsDialog } from '../components/CompareModelsDialog';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { BenchmarkRunDetail } from './BenchmarkRunDetail';
import { SearchableSelect, type SelectOption } from '../components/SearchableSelect';
import { formatDate } from '../lib/format';
import { useUrlParam } from '../lib/urlState';
import { useStopBenchmarkRun, useRetryBenchmarkRun, canStop, canRetry, stopLabel } from '../lib/benchmarkActions';

interface BenchmarkRun {
  id: string;
  name: string;
  description: string | null;
  status: string;
  model_ids?: string[];
  model_names?: string[];
  training_dataset_ids?: string[];
  dataset_names?: string[];
  dataset_type_id?: string | null;
  dataset_type_name?: string | null;
  evaluation_count: number;
  completed_count: number;
  failed_count: number;
  created_at: string;
  finished_at: string | null;
}

interface RefOption {
  id: string;
  name: string;
  dataset_type_id?: string;
  version_label?: string | null;
  task_type?: string;
}

type SortOption = 'NEWEST' | 'OLDEST' | 'EVALUATIONS_DESC' | 'PROGRESS_DESC';

export function BenchmarksPage() {
  const [showNew, setShowNew] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [stopConfirm, setStopConfirm] = useState<{ id: string; name: string } | null>(null);
  const [selectedId, setSelectedId] = useUrlParam('benchmarkRunId');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [datasetFilter, setDatasetFilter] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('NEWEST');

  const { data, isLoading, error } = useQuery({
    queryKey: ['benchmark-runs'],
    refetchInterval: 5000,
    queryFn: () => apiGetList<BenchmarkRun>('/benchmark-runs?size=200'),
  });
  const stopMut = useStopBenchmarkRun();
  const retryMut = useRetryBenchmarkRun();

  const { data: datasetTypesData } = useQuery({
    queryKey: ['dt-filter'],
    queryFn: () => apiGetList<RefOption>('/admin/dataset-types?size=100'),
  });
  const { data: modelsData } = useQuery({
    queryKey: ['model-filter'],
    queryFn: () => apiGetList<RefOption>('/models?size=500'),
  });
  const { data: datasetsData } = useQuery({
    queryKey: ['dataset-filter'],
    queryFn: () => apiGetList<RefOption>('/training-datasets?size=500'),
  });

  const runs = data?.data ?? [];

  const filteredRuns = useMemo(() => {
    let result = runs.filter((r) => {
      if (search) {
        const q = search.toLowerCase();
        if (!r.name.toLowerCase().includes(q) && !(r.description?.toLowerCase().includes(q))) return false;
      }
      if (statusFilter && r.status !== statusFilter) return false;
      if (typeFilter && r.dataset_type_id !== typeFilter) return false;
      if (modelFilter && !(r.model_ids ?? []).includes(modelFilter)) return false;
      if (datasetFilter && !(r.training_dataset_ids ?? []).includes(datasetFilter)) return false;
      return true;
    });

    result.sort((a, b) => {
      if (sortBy === 'OLDEST') return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      if (sortBy === 'EVALUATIONS_DESC') return b.evaluation_count - a.evaluation_count;
      if (sortBy === 'PROGRESS_DESC') {
        const pa = a.evaluation_count > 0 ? a.completed_count / a.evaluation_count : 0;
        const pb = b.evaluation_count > 0 ? b.completed_count / b.evaluation_count : 0;
        return pb - pa;
      }
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

    return result;
  }, [runs, search, statusFilter, typeFilter, modelFilter, datasetFilter, sortBy]);

  if (selectedId) return <BenchmarkRunDetail id={selectedId} onBack={() => setSelectedId(null)} />;

  const statusOptions: SelectOption[] = [
    { value: 'QUEUED', label: 'Queued' },
    { value: 'RUNNING', label: 'Running' },
    { value: 'COMPLETED', label: 'Completed' },
    { value: 'PARTIALLY_FAILED', label: 'Partially Failed' },
    { value: 'FAILED', label: 'Failed' },
    { value: 'CANCELLED', label: 'Cancelled' },
  ];

  const allModels = (modelsData?.data ?? []);
  const allDatasets = (datasetsData?.data ?? []);
  const allTypes = (datasetTypesData?.data ?? []);

  const modelTypeId = allModels.find((m) => m.id === modelFilter)?.dataset_type_id;
  const datasetTypeId = allDatasets.find((d) => d.id === datasetFilter)?.dataset_type_id;

  // Cascading option lists: each filter constrains what the others may show.
  const typeOptions: SelectOption[] = allTypes
    .filter((t) => (!modelFilter || t.id === modelTypeId) && (!datasetFilter || t.id === datasetTypeId))
    .map((t) => ({ value: t.id, label: t.name }));

  const modelOptions: SelectOption[] = allModels
    .filter((m) => (!typeFilter || m.dataset_type_id === typeFilter) && (!datasetFilter || m.dataset_type_id === datasetTypeId))
    .map((m) => ({
      value: m.id,
      label: m.name,
      hint: [m.version_label, m.task_type].filter(Boolean).join(' · '),
    }));

  const datasetOptions: SelectOption[] = allDatasets
    .filter((d) => (!typeFilter || d.dataset_type_id === typeFilter) && (!modelFilter || d.dataset_type_id === modelTypeId))
    .map((d) => ({
      value: d.id,
      label: d.name,
      hint: d.task_type,
    }));

  const handleTypeChange = (v: string) => {
    setTypeFilter(v);
    if (v) {
      const m = allModels.find((x) => x.id === modelFilter);
      if (m && m.dataset_type_id !== v) setModelFilter('');
      const d = allDatasets.find((x) => x.id === datasetFilter);
      if (d && d.dataset_type_id !== v) setDatasetFilter('');
    }
  };

  const handleModelChange = (v: string) => {
    setModelFilter(v);
    const m = allModels.find((x) => x.id === v);
    if (m?.dataset_type_id) {
      if (typeFilter && typeFilter !== m.dataset_type_id) setTypeFilter(m.dataset_type_id);
      const d = allDatasets.find((x) => x.id === datasetFilter);
      if (d && d.dataset_type_id !== m.dataset_type_id) setDatasetFilter('');
    }
  };

  const handleDatasetChange = (v: string) => {
    setDatasetFilter(v);
    const d = allDatasets.find((x) => x.id === v);
    if (d?.dataset_type_id) {
      if (typeFilter && typeFilter !== d.dataset_type_id) setTypeFilter(d.dataset_type_id);
      const m = allModels.find((x) => x.id === modelFilter);
      if (m && m.dataset_type_id !== d.dataset_type_id) setModelFilter('');
    }
  };

  const sortOptions: SelectOption[] = [
    { value: 'NEWEST', label: 'Newest First' },
    { value: 'OLDEST', label: 'Oldest First' },
    { value: 'EVALUATIONS_DESC', label: 'Most Evaluations' },
    { value: 'PROGRESS_DESC', label: 'Highest Progress %' },
  ];

  const hasActiveFilters = !!(search || statusFilter || typeFilter || modelFilter || datasetFilter);
  const clearAll = () => {
    setSearch('');
    setStatusFilter('');
    setTypeFilter('');
    setModelFilter('');
    setDatasetFilter('');
  };

  const selectStyle: React.CSSProperties = { minWidth: '0', flex: 1 };

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h2 style={{ margin: 0 }}>Benchmarks</h2>
            {data && <span className="count">{data.meta.total} total</span>}
          </div>
          <p style={{ margin: '4px 0 0 0', color: 'var(--text-sub)', fontSize: '13px' }}>
            Multi-model x dataset evaluation experiments
          </p>
        </div>
        <div className="spacer" />
        <button className="btn btn-secondary" onClick={() => setShowCompare(true)}>
          Compare Models
        </button>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>
          + New Benchmark Run
        </button>
      </header>

      {/* Filter Bar */}
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: '12px 16px',
          marginBottom: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        {/* Row 1: Text search + Sort + Clear */}
        <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 2, minWidth: '200px' }}>
            <input
              type="text"
              placeholder="🔍 Search by name or description..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                width: '100%',
                padding: '7px 12px',
                fontSize: '13px',
                background: 'var(--bg)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
              }}
            />
          </div>

          <SearchableSelect
            label=""
            options={sortOptions}
            value={sortBy}
            onChange={(v) => setSortBy(v as SortOption)}
            placeholder="Sort: Newest First"
            style={{ flex: 1, minWidth: '140px' }}
          />

          {hasActiveFilters && (
            <button
              className="btn btn-sm btn-secondary"
              onClick={clearAll}
              style={{ whiteSpace: 'nowrap', height: '34px' }}
            >
              ✕ Clear Filters
            </button>
          )}
        </div>

        {/* Row 2: Dropdown filters */}
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <SearchableSelect
            label="Status"
            options={statusOptions}
            value={statusFilter}
            onChange={setStatusFilter}
            placeholder="All Statuses"
            style={{ ...selectStyle, minWidth: '130px' }}
          />
          <SearchableSelect
            label="Dataset Type"
            options={typeOptions}
            value={typeFilter}
            onChange={handleTypeChange}
            placeholder="All Types"
            searchable
            style={{ ...selectStyle, minWidth: '130px' }}
          />
          <SearchableSelect
            label="Model"
            options={modelOptions}
            value={modelFilter}
            onChange={handleModelChange}
            placeholder="All Models"
            searchable
            style={{ ...selectStyle, minWidth: '130px' }}
          />
          <SearchableSelect
            label="Dataset"
            options={datasetOptions}
            value={datasetFilter}
            onChange={handleDatasetChange}
            placeholder="All Datasets"
            searchable
            style={{ ...selectStyle, minWidth: '130px' }}
          />
        </div>
      </div>

      {isLoading && <SkeletonLoader rows={5} variant="list" />}
      {error && <EmptyState type="error" message={(error as Error).message} />}
      {data && filteredRuns.length === 0 && (
        <EmptyState message={runs.length === 0 ? 'No benchmark runs yet.' : 'No benchmark runs match your filters.'} />
      )}

      {data && filteredRuns.length > 0 && (
        <div className="job-list">
          {filteredRuns.map((b) => {
            const pct = b.evaluation_count > 0 ? Math.round((b.completed_count / b.evaluation_count) * 100) : 0;
            return (
              <div key={b.id} className="job-card" onClick={() => setSelectedId(b.id)} style={{ cursor: 'pointer' }}>
                <div className="job-card-body">
                  <div className="job-card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span className="job-card-name" style={{ fontWeight: 600, fontSize: '15px', color: 'var(--text)' }}>{b.name}</span>
                        {b.dataset_type_name && (
                          <span style={{ fontSize: '11px', background: 'var(--surface-muted)', color: 'var(--text-sub)', padding: '2px 8px', borderRadius: '10px', border: '1px solid var(--border)' }}>
                            {b.dataset_type_name}
                          </span>
                        )}
                      </div>
                      {b.description && (
                        <div style={{ fontSize: '12px', color: 'var(--text-sub)', marginTop: '4px' }}>
                          {b.description}
                        </div>
                      )}
                      {/* Model & Dataset summary badges */}
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
                        {(b.model_names ?? []).slice(0, 3).map((mn, i) => (
                          <span key={i} style={{ fontSize: '10px', color: 'var(--blue)', background: 'var(--blue-glow)', padding: '1px 6px', borderRadius: '4px' }}>
                            {mn}
                          </span>
                        ))}
                        {(b.model_names ?? []).length > 3 && (
                          <span style={{ fontSize: '10px', color: 'var(--text-sub)' }}>+{b.model_names!.length - 3} more</span>
                        )}
                        {(b.dataset_names ?? []).slice(0, 2).map((dn, i) => (
                          <span key={`d${i}`} style={{ fontSize: '10px', color: 'var(--green)', background: 'rgba(32,194,90,0.12)', padding: '1px 6px', borderRadius: '4px' }}>
                            {dn}
                          </span>
                        ))}
                        {(b.dataset_names ?? []).length > 2 && (
                          <span style={{ fontSize: '10px', color: 'var(--text-sub)' }}>+{b.dataset_names!.length - 2} more</span>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <StatusBadge status={b.status} />
                      {canStop(b.status) && (
                        <button
                          className="btn btn-sm btn-danger"
                          disabled={stopMut.isPending}
                          onClick={(e) => {
                            e.stopPropagation();
                            setStopConfirm({ id: b.id, name: b.name });
                          }}
                        >
                          {stopMut.isPending ? '…' : stopLabel(b.status)}
                        </button>
                      )}
                      {canRetry(b.status) && (
                        <button
                          className="btn btn-sm btn-secondary"
                          disabled={retryMut.isPending}
                          onClick={(e) => {
                            e.stopPropagation();
                            retryMut.mutate(b.id);
                          }}
                        >
                          {retryMut.isPending ? '…' : 'Retry'}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div style={{ marginTop: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-sub)', marginBottom: '4px' }}>
                      <span>
                        {b.completed_count} / {b.evaluation_count} evaluated
                        {b.failed_count > 0 ? ` (${b.failed_count} failed)` : ''}
                      </span>
                      <span style={{ fontWeight: 600, color: 'var(--text)' }}>{pct}%</span>
                    </div>
                    <div style={{ height: '7px', width: '100%', backgroundColor: 'var(--surface-muted)', borderRadius: '4px', overflow: 'hidden' }}>
                      <div
                        style={{
                          height: '100%',
                          width: `${pct}%`,
                          backgroundColor: b.failed_count > 0 ? 'var(--yellow)' : 'var(--primary)',
                          transition: 'width 0.3s ease',
                        }}
                      />
                    </div>
                  </div>
                </div>

                <div className="job-card-meta" style={{ display: 'flex', gap: '16px', fontSize: '12px', color: 'var(--text-sub)', borderTop: '1px solid var(--border)', paddingTop: '10px', marginTop: '12px' }}>
                  <span>Created: {formatDate(b.created_at)}</span>
                  {b.finished_at && <span>Finished: {formatDate(b.finished_at)}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showNew && <NewBenchmarkRunDialog onClose={() => setShowNew(false)} />}
      {showCompare && <CompareModelsDialog onClose={() => setShowCompare(false)} />}
      {stopConfirm && (
        <ConfirmDialog
          title="Stop benchmark run"
          message={`Stop "${stopConfirm.name}"? This cannot be undone.`}
          confirmLabel="Stop"
          danger
          onCancel={() => setStopConfirm(null)}
          onConfirm={() => { const c = stopConfirm; setStopConfirm(null); stopMut.mutate(c.id); }}
        />
      )}
    </section>
  );
}
