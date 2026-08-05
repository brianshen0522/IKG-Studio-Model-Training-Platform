import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGetList } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { EmptyState } from '../components/EmptyState';
import { NewTrainingDatasetWizard } from '../components/NewTrainingDatasetWizard';
import { TrainingDatasetDetailPage } from './TrainingDatasetDetailPage';
import { formatDate } from '../lib/format';
import { useDatasetTypeOptions } from '../lib/options';
import { useUrlParam } from '../lib/urlState';
import { useUiStore } from '../stores/ui';
import { CollapsibleTypeGroup, useTypeGroupCollapse } from '../components/CollapsibleTypeGroup';

interface TrainingDataset {
  id: string;
  name: string;
  description: string | null;
  task_type: string;
  origin: 'BUILT' | 'REGISTERED';
  status: string;
  class_count: number | null;
  train_count: number | null;
  val_count: number | null;
  test_count: number | null;
  dataset_type_id: string;
  created_at: string;
}

const TONE: Record<string, string> = {
  READY: 'var(--green)',
  BUILDING: 'var(--yellow)',
  VALIDATING: 'var(--yellow)',
  SCANNING: 'var(--yellow)',
  PENDING: 'var(--yellow)',
  DRAFT: 'var(--yellow)',
  FAILED: 'var(--red)',
};

export function TrainingDatasetsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useUrlParam('trainingDatasetId');
  const { data, isLoading, error } = useQuery({
    queryKey: ['training-datasets'],
    refetchInterval: 5000,
    queryFn: () => apiGetList<TrainingDataset>('/training-datasets?size=50'),
  });
  const { data: types } = useDatasetTypeOptions();

  const items = data?.data ?? [];
  const typeName = (id: string) => types?.find((t) => t.id === id)?.name ?? 'Unknown type';
  const byType = new Map<string, TrainingDataset[]>();
  for (const d of items) {
    const list = byType.get(d.dataset_type_id) ?? [];
    list.push(d);
    byType.set(d.dataset_type_id, list);
  }
  const groups = [...byType.entries()].sort((a, b) => typeName(a[0]).localeCompare(typeName(b[0])));
  const { isCollapsed, toggleGroup, toggleAll, anyCollapsed } = useTypeGroupCollapse('training', groups.map(([id]) => id));

  const goBack = () => {
    setSelectedId(null);
    const returnModelId = useUiStore.getState().datasetReturnModelId;
    useUiStore.getState().setDatasetReturnModelId(null);
    if (returnModelId) useUiStore.getState().setPage('models');
  };

  if (selectedId) return <TrainingDatasetDetailPage id={selectedId} onBack={goBack} />;

  const readyCount = items.filter((d) => d.status === 'READY').length;
  const activeCount = items.filter((d) => TONE[d.status] === 'var(--yellow)').length;
  const failedCount = items.filter((d) => d.status === 'FAILED').length;

  return (
    <section className="page">
      <header className="page-head">
        <h2>Training Datasets</h2>
        <p className="page-sub">
          Built from source datasets or registered YOLO directories. These are what training and benchmarks point at.
        </p>
        <div className="spacer" />
        {groups.length > 0 && (
          <button className="btn btn-sm btn-ghost" onClick={toggleAll}>
            {anyCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
        )}
        <button className="btn btn-sm btn-primary" onClick={() => setShowCreate(true)}>
          New Training Dataset
        </button>
      </header>

      {data && (
        <div className="stats-strip">
          <span className="stat-pill"><strong>{items.length}</strong> total</span>
          <span className="stat-pill"><strong>{readyCount}</strong> ready</span>
          {activeCount > 0 && <span className="stat-pill"><strong>{activeCount}</strong> in progress</span>}
          {failedCount > 0 && <span className="stat-pill"><strong>{failedCount}</strong> failed</span>}
        </div>
      )}

      {isLoading && <SkeletonLoader rows={5} variant="list" />}
      {error && <EmptyState type="error" message={(error as Error).message} />}
      {data && data.data.length === 0 && (
        <EmptyState message='No training datasets yet. Click "New Training Dataset" to build one from source datasets, or register an existing YOLO directory.' />
      )}

      {groups.map(([typeId, list]) => (
        <CollapsibleTypeGroup
          key={typeId}
          collapsed={isCollapsed(typeId)}
          onToggle={() => toggleGroup(typeId)}
          head={<>
            <span className="type-dot" style={{ background: 'var(--primary)' }} />
            <h3>{typeName(typeId)}</h3>
            <span className="stat-pill">{list.length} dataset{list.length === 1 ? '' : 's'}</span>
          </>}
        >

          <div className="folder-grid">
            {list.map((d) => {
              const tone = TONE[d.status];
              return (
                <div
                  key={d.id}
                  className="folder-card"
                  onClick={() => setSelectedId(d.id)}
                  style={{
                    cursor: 'pointer',
                    ...(tone ? ({ '--tone-color': tone } as React.CSSProperties) : {}),
                  }}
                >
                  <div className="folder-card-head">
                    <span className="folder-name">{d.name}</span>
                    <StatusBadge status={d.status} />
                  </div>
                  <div className="folder-meta">
                    <span className="origin-tag">{d.origin === 'BUILT' ? 'Built' : 'Registered'}</span>
                    <span>{d.task_type}</span>
                  </div>
                  {d.description && <div className="folder-sub">{d.description}</div>}
                  <div className="folder-sub">
                    {d.train_count ?? 0} / {d.val_count ?? 0} / {d.test_count ?? 0} train / val / test
                    {' · '}
                    {d.class_count ?? '—'} classes
                  </div>
                  <div className="folder-sub">Created {formatDate(d.created_at)}</div>
                </div>
              );
            })}
          </div>
        </CollapsibleTypeGroup>
      ))}

      {showCreate && <NewTrainingDatasetWizard onClose={() => setShowCreate(false)} />}
    </section>
  );
}
