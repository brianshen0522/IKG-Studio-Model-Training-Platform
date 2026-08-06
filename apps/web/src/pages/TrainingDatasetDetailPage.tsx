import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiGet, apiSend, ApiError } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { EmptyState } from '../components/EmptyState';
import { PathDisplay } from '../components/PathDisplay';
import { DatasetPreviewPanel } from '../components/DatasetPreviewPanel';
import { ConfirmDialog } from '../components/ConfirmDialog';
import {
  ChartLightbox,
  TextArtifactModal,
  isImageArtifact,
  isTextArtifact,
  type ChartArtifact,
} from '../components/ChartViewer';
import { formatDate, formatBytes } from '../lib/format';
import { useAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';
import { queryClient } from '../lib/queryClient';
import { useUrlParam } from '../lib/urlState';

const CLASS_COLLAPSE_THRESHOLD = 8;

interface DatasetData {
  id: string;
  name: string;
  description: string | null;
  dataset_type_id: string;
  task_type: string;
  origin: 'BUILT' | 'REGISTERED';
  status: string;
  source_dataset_ids: string[] | null;
  version_number: number;
  split_strategy: string | null;
  random_seed: number | null;
  train_ratio: string | null;
  val_ratio: string | null;
  test_ratio: string | null;
  storage_mode: string | null;
  train_count: string | number | null;
  val_count: string | number | null;
  test_count: string | number | null;
  class_count: number | null;
  classes_hash: string | null;
  configuration_hash: string | null;
  failure_code: string | null;
  failure_message: string | null;
  build_started_at: string | null;
  build_finished_at: string | null;
  created_at: string;
  ready_at: string | null;
  archived_at: string | null;
  relative_path: string | null;
}

interface SourceItem {
  id: string;
  name: string;
  relative_path: string;
  task_type: string;
  status: string;
}

interface ClassItem {
  class_index: number;
  class_name: string;
}

interface Artifact extends ChartArtifact {
  status: string;
  file_size_bytes: string;
  created_at: string;
}

type PreviewState =
  | { kind: 'image'; index: number }
  | { kind: 'text'; artifact: Artifact }
  | null;

export function TrainingDatasetDetailPage({ id, onBack }: { id: string; onBack: () => void }) {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  const currentUserRole = useAuthStore((s) => s.user?.role);
  const setDatasetTab = useUiStore((s) => s.setDatasetTab);
  const setSourceReturnTrainingDatasetId = useUiStore((s) => s.setSourceReturnTrainingDatasetId);
  const [, setSourceDatasetId] = useUrlParam('sourceDatasetId');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>(null);

  const { data: ds, isLoading, error } = useQuery({
    queryKey: ['training-dataset', id],
    queryFn: () => apiGet<DatasetData>(`/training-datasets/${id}`),
    retry: (failureCount, err) => (err as ApiError).status === 404 ? false : failureCount < 3,
    refetchInterval: (q) => {
      if (q.state.error) return false;
      const s = (q.state.data as DatasetData | undefined)?.status;
      return s === 'BUILDING' || s === 'VALIDATING' ? 3000 : false;
    },
  });

  const sources = useQuery({
    queryKey: ['training-dataset-sources', id],
    queryFn: () => apiGet<SourceItem[]>(`/training-datasets/${id}/sources`),
  });

  const classes = useQuery({
    queryKey: ['training-dataset-classes', id],
    queryFn: () => apiGet<ClassItem[]>(`/training-datasets/${id}/classes`),
  });

  const artifacts = useQuery({
    queryKey: ['training-dataset-artifacts', id],
    queryFn: () => apiGet<Artifact[]>(`/training-datasets/${id}/artifacts`),
  });

  const artifactRows = artifacts.data ?? [];
  const imageArtifacts = artifactRows.filter(isImageArtifact);
  const openArtifact = (artifact: Artifact) => {
    if (isImageArtifact(artifact)) {
      setPreview({
        kind: 'image',
        index: imageArtifacts.findIndex((candidate) => candidate.id === artifact.id),
      });
    } else if (isTextArtifact(artifact)) {
      setPreview({ kind: 'text', artifact });
    }
  };

  const openSourceDataset = (sourceId: string) => {
    setSourceReturnTrainingDatasetId(id);
    setDatasetTab('source');
    setSourceDatasetId(sourceId);
  };

  const deleteMutation = useMutation({
    mutationFn: () => apiSend<{ id: string }>('DELETE', `/training-datasets/${id}`, undefined, csrfToken),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['training-datasets'] });
      onBack();
    },
  });

  const openDeleteConfirm = async () => {
    let warning = ds?.origin === 'REGISTERED'
      ? 'Delete this training dataset? Only the platform record is removed — the directory on disk is left untouched.'
      : 'Delete this training dataset? Its directory on disk is removed.';
    try {
      const a = await apiGet<{
        training_jobs: { id: string; name: string }[];
        benchmark_run_ids: string[];
        benchmark_evaluation_count: number;
      }>(`/training-datasets/${id}/associations`);
      const bits: string[] = [];
      if (a.training_jobs.length) bits.push(`used by ${a.training_jobs.length} training job(s)`);
      if (a.benchmark_run_ids.length) bits.push(`referenced by ${a.benchmark_run_ids.length} benchmark run(s)`);
      if (a.benchmark_evaluation_count) bits.push(`part of ${a.benchmark_evaluation_count} benchmark evaluation(s)`);
      if (bits.length) warning += `\n\nThis dataset is ${bits.join(', ')}. Those records stay intact, but the dataset itself will be gone.`;
    } catch {
      // Associations lookup failing shouldn't block the confirm dialog; the delete
      // call itself still checks the dataset exists.
    }
    setDeleteConfirm(warning);
  };

  // A registered dataset that failed validation, or a built one whose build failed,
  // can be resubmitted once the underlying problem is fixed on disk.
  const submitMutation = useMutation({
    mutationFn: () => apiSend<{ id: string }>('POST', `/training-datasets/${id}/submit`, undefined, csrfToken),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['training-dataset', id] });
      queryClient.invalidateQueries({ queryKey: ['training-datasets'] });
    },
  });

  const classNameMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of classes.data ?? []) m.set(c.class_index, c.class_name);
    return m;
  }, [classes.data]);

  const trainN = Number(ds?.train_count ?? 0);
  const valN = Number(ds?.val_count ?? 0);
  const testN = Number(ds?.test_count ?? 0);
  const total = trainN + valN + testN;
  const pct = (n: string | number | null | undefined) =>
    total > 0 && n != null ? `${((Number(n) / total) * 100).toFixed(0)}%` : '—';

  return (
    <section className="page">
      <div className="detail-actions">
        <button className="back-btn" onClick={onBack}>← Back</button>
      </div>

      {isLoading && <SkeletonLoader rows={5} cols={4} />}
      {error && (
        <EmptyState
          type="error"
          message={
            (error as ApiError).status === 404
              ? 'This training dataset no longer exists or you may not have access to it.'
              : (error as Error).message
          }
        />
      )}

      {ds && (
        <>
          <header className="page-head">
            <div>
              <h2>{ds.name}</h2>
              <p className="page-sub">
                {ds.origin === 'BUILT' ? 'Built from source datasets' : 'Registered directory'}
                {' · '}{ds.task_type}{' · '}Version {ds.version_number}
              </p>
            </div>
            <StatusBadge status={ds.status} />
          </header>
          {ds.description && <p className="hint">{ds.description}</p>}
          <div className={`detail-layout${ds.status === 'READY' ? '' : ' is-single'}`}>
            <div className="detail-main">

              <section className="card">
                <div className="card-title-row">
                  <h3 className="card-title">Training Dataset</h3>
                  <div className="card-title-actions">
                    {ds.status === 'INVALID' && !ds.archived_at && (
                      <button
                        className="btn btn-sm btn-ghost"
                        disabled={submitMutation.isPending}
                        onClick={() => submitMutation.mutate()}
                      >
                        {submitMutation.isPending ? 'Retrying…' : ds.origin === 'REGISTERED' ? 'Re-validate' : 'Rebuild'}
                      </button>
                    )}
                    {currentUserRole === 'ADMIN' && ds.status !== 'DELETED' && (
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={deleteMutation.isPending || ds.status === 'BUILDING' || ds.status === 'VALIDATING'}
                        title={ds.status === 'BUILDING' || ds.status === 'VALIDATING' ? 'Cannot delete while building or validating' : undefined}
                        onClick={openDeleteConfirm}
                      >
                        {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
                      </button>
                    )}
                  </div>
                </div>
                <dl className="dl">
                  <div><dt>Origin</dt><dd>{ds.origin === 'BUILT' ? 'Built from source datasets' : 'Registered directory'}</dd></div>
                  <div><dt>Task type</dt><dd>{ds.task_type}</dd></div>
                  {ds.relative_path && <div><dt>Path</dt><dd><PathDisplay path={ds.relative_path} /></dd></div>}
                  <div><dt>Created</dt><dd>{formatDate(ds.created_at)}</dd></div>
                  {ds.ready_at && <div><dt>Ready</dt><dd>{formatDate(ds.ready_at)}</dd></div>}
                </dl>
              </section>

              {ds.status === 'INVALID' && ds.failure_message && (
                <EmptyState type="error" message={`${ds.failure_code}: ${ds.failure_message}`} />
              )}

              {ds.origin === 'BUILT' && ds.split_strategy && (
                <section className="card">
                  <h3 className="card-title">Build Configuration</h3>
                  <dl className="dl">
                    <div><dt>Split strategy</dt><dd>{ds.split_strategy}</dd></div>
                    <div><dt>Storage mode</dt><dd>{ds.storage_mode}</dd></div>
                    {ds.split_strategy === 'RANDOM' && (
                      <>
                        <div><dt>Random seed</dt><dd>{ds.random_seed ?? '—'}</dd></div>
                        <div><dt>Train ratio</dt><dd>{ds.train_ratio}</dd></div>
                        <div><dt>Val ratio</dt><dd>{ds.val_ratio}</dd></div>
                        <div><dt>Test ratio</dt><dd>{ds.test_ratio}</dd></div>
                      </>
                    )}
                    {ds.configuration_hash && <div><dt>Config hash</dt><dd><PathDisplay path={ds.configuration_hash} maxLength={16} /></dd></div>}
                    <div><dt>Build started</dt><dd>{formatDate(ds.build_started_at)}</dd></div>
                    <div><dt>Build finished</dt><dd>{formatDate(ds.build_finished_at)}</dd></div>
                  </dl>
                </section>
              )}

              {(ds.status === 'READY' || total > 0) && (
                <section className="card">
                  <h3 className="card-title">
                    Dataset Splits
                    <span className="card-hint">{total.toLocaleString()} images total</span>
                  </h3>
                  {total > 0 && (
                    <div className="ratio-bar" aria-label="Dataset split proportions">
                      {trainN > 0 && <div className="ratio-seg ratio-train" style={{ width: pct(ds.train_count) }}>Train {pct(ds.train_count)}</div>}
                      {valN > 0 && <div className="ratio-seg ratio-val" style={{ width: pct(ds.val_count) }}>Val {pct(ds.val_count)}</div>}
                      {testN > 0 && <div className="ratio-seg ratio-test" style={{ width: pct(ds.test_count) }}>Test {pct(ds.test_count)}</div>}
                    </div>
                  )}
                  <dl className="dl">
                    <div><dt>Train</dt><dd>{trainN.toLocaleString()} images ({pct(ds.train_count)})</dd></div>
                    <div><dt>Validation</dt><dd>{valN.toLocaleString()} images ({pct(ds.val_count)})</dd></div>
                    <div><dt>Test</dt><dd>{testN.toLocaleString()} images ({pct(ds.test_count)})</dd></div>
                  </dl>
                </section>
              )}

              {sources.data && sources.data.length > 0 && (
                <section className="card">
                  <h3 className="card-title">
                    Sources
                    <span className="card-hint">{sources.data.length} dataset{sources.data.length === 1 ? '' : 's'}</span>
                  </h3>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr><th>Name</th><th>Path</th><th>Task</th></tr>
                      </thead>
                      <tbody>
                        {sources.data.map((s) => (
                          <tr
                            key={s.id}
                            className="row-link"
                            title="Open source dataset"
                            onClick={() => openSourceDataset(s.id)}
                          >
                            <td>{s.name}</td>
                            <td><code>{s.relative_path}</code></td>
                            <td>{s.task_type}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {ds.origin === 'REGISTERED' && ds.status === 'READY' && (
                <section className="card">
                  <h3 className="card-title">Classes</h3>
                  {/* Classes come from the directory's own data.yaml, which the validation scan
                      hashes and counts but does not enumerate into source_dataset_classes. */}
                  <dl className="dl">
                    <div><dt>Declared</dt><dd>{ds.class_count ?? 0} classes in data.yaml</dd></div>
                    {ds.classes_hash && <div><dt>Classes hash</dt><dd><code>{ds.classes_hash.slice(0, 16)}…</code></dd></div>}
                  </dl>
                </section>
              )}

              {classes.data && classes.data.length > 0 && (
                <section className="card">
                  <details className="collapse" open={classes.data.length <= CLASS_COLLAPSE_THRESHOLD}>
                    <summary className="card-title collapse-summary">Classes ({ds.class_count})</summary>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr><th>Index</th><th>Name</th></tr>
                        </thead>
                        <tbody>
                          {classes.data.map((c) => (
                            <tr key={c.class_index}>
                              <td>{c.class_index}</td>
                              <td>{c.class_name}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </section>
              )}

              {artifactRows.length > 0 && (
                <section className="card">
                  <h3 className="card-title">
                    Artifacts
                    <span className="card-hint">click a supported file to preview</span>
                  </h3>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr><th>Type</th><th>File</th><th>Size</th><th>Created</th></tr>
                      </thead>
                      <tbody>
                        {artifactRows.map((a) => (
                          <tr key={a.id}>
                            <td>{a.artifact_type_code}</td>
                            <td>
                              {isImageArtifact(a) || isTextArtifact(a) ? (
                                <button className="link-btn" title="Open preview" onClick={() => openArtifact(a)}>
                                  {a.filename}
                                </button>
                              ) : (
                                <a href={`/api/v1/artifacts/${a.id}/download`}>{a.filename}</a>
                              )}
                            </td>
                            <td className="nums">{formatBytes(Number(a.file_size_bytes))}</td>
                            <td>{formatDate(a.created_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {ds.status === 'DRAFT' && (
                <EmptyState message={
                  ds.origin === 'REGISTERED'
                    ? 'Not validated yet — submit it to check data.yaml and count the splits.'
                    : 'No build configured yet — configure sources and split, then submit the build.'
                } />
              )}
            </div>

          {ds.status === 'READY' && (
            <aside className="detail-side">
              <section className="card">
                <h3 className="card-title">
                  Dataset Preview
                  <span className="card-hint">images with labels</span>
                </h3>
                <DatasetPreviewPanel datasetId={ds.id} classNames={classNameMap} />
              </section>
            </aside>
          )}
          </div>
        </>
      )}
      {deleteConfirm && (
        <ConfirmDialog
          title="Delete Training Dataset"
          message={deleteConfirm}
          confirmLabel="Delete"
          danger
          onCancel={() => setDeleteConfirm(null)}
          onConfirm={() => { setDeleteConfirm(null); deleteMutation.mutate(); }}
        />
      )}
      {preview?.kind === 'image' && (
        <ChartLightbox
          artifacts={imageArtifacts}
          index={preview.index}
          onNavigate={(index) => setPreview({ kind: 'image', index })}
          onClose={() => setPreview(null)}
        />
      )}
      {preview?.kind === 'text' && (
        <TextArtifactModal artifact={preview.artifact} onClose={() => setPreview(null)} />
      )}
    </section>
  );
}
