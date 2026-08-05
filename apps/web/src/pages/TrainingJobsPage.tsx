import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGetList } from '../lib/api';
import { useStopTrainingJob, useRetryTrainingJob, canStop, canRetry, stopLabel } from '../lib/trainingActions';
import { StatusBadge } from '../components/StatusBadge';
import { NewTrainingWizard } from '../components/NewTrainingWizard';
import { TrainingJobDetail } from './TrainingJobDetail';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { EmptyState } from '../components/EmptyState';
import { formatDate } from '../lib/format';
import { useUrlParam } from '../lib/urlState';
import { useUiStore } from '../stores/ui';
import { SearchableSelect, type SelectOption } from '../components/SearchableSelect';

interface TrainingJob {
  id: string;
  name: string;
  status: string;
  result_model_id: string | null;
  model_name?: string | null;
  training_dataset_name?: string | null;
  dataset_type_id?: string | null;
  dataset_type_name?: string | null;
  created_at: string;
  submitted_at: string | null;
  finished_at: string | null;
}

interface RefOption {
  id: string;
  name: string;
  dataset_type_id?: string;
  version_label?: string | null;
  task_type?: string;
}

type SortOption = 'NEWEST' | 'OLDEST' | 'NAME_AZ';

const STATUS_OPTIONS: SelectOption[] = [
  { value: 'SCHEDULED', label: 'Scheduled' },
  { value: 'QUEUED', label: 'Queued' },
  { value: 'PREPARING', label: 'Preparing' },
  { value: 'RUNNING', label: 'Running' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'STOPPED', label: 'Stopped' },
  { value: 'BLOCKED', label: 'Blocked' },
  { value: 'STOPPING', label: 'Stopping' },
];

export function TrainingJobsPage() {
  const [showNew, setShowNew] = useState(false);
  const [selectedId, setSelectedId] = useUrlParam('trainingJobId');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [datasetFilter, setDatasetFilter] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('NEWEST');
  const stopMut = useStopTrainingJob();
  const retryMut = useRetryTrainingJob();

  const { data, isLoading, error } = useQuery({
    queryKey: ['training-jobs'],
    refetchInterval: 5000,
    queryFn: () => apiGetList<TrainingJob>('/training-jobs?size=200'),
  });

  const { data: datasetTypesData } = useQuery({
    queryKey: ['tj-dt-filter'],
    queryFn: () => apiGetList<RefOption>('/admin/dataset-types?size=100'),
  });
  const { data: modelsData } = useQuery({
    queryKey: ['tj-model-filter'],
    queryFn: () => apiGetList<RefOption>('/models?size=500'),
  });
  const { data: datasetsData } = useQuery({
    queryKey: ['tj-dataset-filter'],
    queryFn: () => apiGetList<RefOption>('/training-datasets?size=500'),
  });

  const jobs = data?.data ?? [];
  const allModels = modelsData?.data ?? [];
  const allDatasets = datasetsData?.data ?? [];
  const allTypes = datasetTypesData?.data ?? [];

  const modelName = allModels.find((m) => m.id === modelFilter)?.name;
  const datasetName = allDatasets.find((d) => d.id === datasetFilter)?.name;
  const modelTypeId = allModels.find((m) => m.id === modelFilter)?.dataset_type_id;
  const datasetTypeId = allDatasets.find((d) => d.id === datasetFilter)?.dataset_type_id;

  const filteredJobs = useMemo(() => {
    let result = jobs.filter((j) => {
      if (search) {
        const q = search.toLowerCase();
        if (!j.name.toLowerCase().includes(q) && !(j.model_name ?? '').toLowerCase().includes(q) && !(j.training_dataset_name ?? '').toLowerCase().includes(q)) return false;
      }
      if (statusFilter && j.status !== statusFilter) return false;
      if (typeFilter && j.dataset_type_id !== typeFilter) return false;
      if (modelFilter && (j.model_name ?? null) !== modelName) return false;
      if (datasetFilter && (j.training_dataset_name ?? null) !== datasetName) return false;
      return true;
    });

    result.sort((a, b) => {
      if (sortBy === 'OLDEST') return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      if (sortBy === 'NAME_AZ') return a.name.localeCompare(b.name);
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

    return result;
  }, [jobs, search, statusFilter, typeFilter, modelFilter, datasetFilter, sortBy, modelName, datasetName]);

  const goBack = () => {
    setSelectedId(null);
    const returnModelId = useUiStore.getState().trainingReturnModelId;
    useUiStore.getState().setTrainingReturnModelId(null);
    if (returnModelId) useUiStore.getState().setPage('models');
  };

  if (selectedId) return <TrainingJobDetail id={selectedId} onBack={goBack} />;

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
    { value: 'NAME_AZ', label: 'Name A–Z' },
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
            <h2 style={{ margin: 0 }}>Training Jobs</h2>
            {data && <span className="count">{data.meta.total} total</span>}
          </div>
          <p style={{ margin: '4px 0 0 0', color: 'var(--text-sub)', fontSize: '13px' }}>
            YOLO training jobs and their run history
          </p>
        </div>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>
          + New Training Job
        </button>
      </header>

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
        <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 2, minWidth: '200px' }}>
            <input
              type="text"
              placeholder="🔍 Search by name, model, or dataset..."
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
            >
              ✕ Clear Filters
            </button>
          )}
        </div>

        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <SearchableSelect
            label="Status"
            options={STATUS_OPTIONS}
            value={statusFilter}
            onChange={setStatusFilter}
            placeholder="All Statuses"
            style={{ flex: 1, minWidth: '130px', maxWidth: '180px' }}
          />
          <SearchableSelect
            label="Dataset Type"
            options={typeOptions}
            value={typeFilter}
            onChange={handleTypeChange}
            placeholder="All Types"
            searchable
            style={{ ...selectStyle, minWidth: '150px', maxWidth: '200px' }}
          />
          <SearchableSelect
            label="Model"
            options={modelOptions}
            value={modelFilter}
            onChange={handleModelChange}
            placeholder="All Models"
            searchable
            style={{ ...selectStyle, minWidth: '170px' }}
          />
          <SearchableSelect
            label="Dataset"
            options={datasetOptions}
            value={datasetFilter}
            onChange={handleDatasetChange}
            placeholder="All Datasets"
            searchable
            style={{ ...selectStyle, minWidth: '170px' }}
          />
        </div>
      </div>

      {isLoading && <SkeletonLoader rows={5} variant="list" />}
      {error && <EmptyState type="error" message={(error as Error).message} />}
      {!isLoading && !error && data && filteredJobs.length === 0 && (
        <EmptyState message="No training jobs match your filters." />
      )}

      {filteredJobs.length > 0 && (
        <div className="job-list">
          {filteredJobs.map((j) => (
            <div key={j.id} className="job-card" onClick={() => setSelectedId(j.id)} style={{ cursor: 'pointer' }}>
              <div className="job-card-body">
                <div className="job-card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span className="job-card-name" style={{ fontWeight: 600, fontSize: '15px', color: 'var(--text)' }}>{j.name}</span>
                      {j.dataset_type_name && (
                        <span style={{ fontSize: '11px', background: 'var(--surface-muted)', color: 'var(--text-sub)', padding: '2px 8px', borderRadius: '10px', border: '1px solid var(--border)' }}>
                          {j.dataset_type_name}
                        </span>
                      )}
                    </div>
                    <div className="job-card-sub" style={{ marginTop: '4px' }}>
                      {j.result_model_id ? 'Result model: ✓' : 'No result model yet'}
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
                      {j.model_name && (
                        <span style={{ fontSize: '10px', color: 'var(--blue)', background: 'var(--blue-glow)', padding: '1px 6px', borderRadius: '4px' }}>
                          {j.model_name}
                        </span>
                      )}
                      {j.training_dataset_name && (
                        <span style={{ fontSize: '10px', color: 'var(--green)', background: 'rgba(32,194,90,0.12)', padding: '1px 6px', borderRadius: '4px' }}>
                          {j.training_dataset_name}
                        </span>
                      )}
                    </div>
                  </div>
                  <StatusBadge status={j.status} />
                </div>
              </div>
              <div className="job-card-meta">
                <span>Submitted {formatDate(j.submitted_at)}</span>
                <span>Finished {formatDate(j.finished_at)}</span>
                {(canStop(j.status) || canRetry(j.status)) && (
                  <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                    {canStop(j.status) && (
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={stopMut.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!window.confirm(`Stop "${j.name}"? This cannot be undone.`)) return;
                          stopMut.mutate(j.id);
                        }}
                      >
                        {stopMut.isPending ? '…' : stopLabel(j.status)}
                      </button>
                    )}
                    {canRetry(j.status) && (
                      <button
                        className="btn btn-sm btn-secondary"
                        disabled={retryMut.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          retryMut.mutate(j.id);
                        }}
                      >
                        {retryMut.isPending ? '…' : 'Retry'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {showNew && <NewTrainingWizard onClose={() => setShowNew(false)} />}
    </section>
  );
}
