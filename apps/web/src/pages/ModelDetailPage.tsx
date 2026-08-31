import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet, ApiError } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { EmptyState } from '../components/EmptyState';
import { formatDate, formatBytes } from '../lib/format';
import { useAuthStore } from '../stores/auth';
import { useMutation } from '@tanstack/react-query';
import { apiSend } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { ChartGrid, ChartLightbox, TextArtifactModal, ARTIFACT_LABELS, isImageArtifact, isTextArtifact, type ChartArtifact } from '../components/ChartViewer';
import { TrainingCurves } from '../components/TrainingCurves';
import { Collapsible } from '../components/Collapsible';
import { CopyButton } from '../components/CopyButton';
import { buildYoloCommand } from '@model-trainer/shared-types';
import { ModelConversionWizard } from '../components/ModelConversionWizard';
import { JobDetailModal } from '../components/JobDetailModal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useUiStore } from '../stores/ui';
import { useUrlParam } from '../lib/urlState';

interface Artifact extends ChartArtifact {
  file_size_bytes: string;
  created_at: string;
}

interface ModelData {
  id: string;
  name: string;
  version_label: string | null;
  description: string | null;
  dataset_type_id: string;
  task_type: string;
  source_type: string;
  status: string;
  model_root_id: string;
  relative_path: string;
  original_filename: string;
  file_size_bytes: number | null;
  checksum: string;
  source_training_job_id: string | null;
  architecture_metadata: Record<string, unknown>;
  runtime_metadata: Record<string, unknown>;
  validation_summary: Record<string, unknown>;
  row_version: number;
  created_at: string;
  available_at: string | null;
  archived_at: string | null;
}

interface TrainingJobRef {
  id: string;
  name: string;
  status: string;
  hyperparameters: Record<string, unknown>;
  training_dataset_id: string;
  base_model_id: string | null;
  started_at: string | null;
  finished_at: string | null;
}

interface TrainingDatasetRef { id: string; name: string; relative_path: string | null }
interface BaseModelRef { id: string; name: string; original_filename: string | null }

interface ModelConversion {
  id: string;
  model_id: string;
  status: string;
  args: Record<string, unknown>;
  artifact_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  artifact_filename: string | null;
  artifact_size: string | null;
  created_at: string;
  finished_at: string | null;
  job_execution_id: string | null;
}

// Charts are only the fixed training plots; validation batch images and the log/CSV
// stay in the Artifacts table, where every row opens a preview.
const CHART_TYPES = ['CONFUSION_MATRIX_NORMALIZED', 'RESULTS_IMAGE'];

type PreviewState =
  | { kind: 'image'; index: number }
  | { kind: 'text'; artifact: Artifact }
  | null;

export function ModelDetailPage({ id, onBack }: { id: string; onBack: () => void }) {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  const currentUserRole = useAuthStore((s) => s.user?.role);
  const setPage = useUiStore((s) => s.setPage);
  const setTrainingReturnModelId = useUiStore((s) => s.setTrainingReturnModelId);
  const setDatasetTab = useUiStore((s) => s.setDatasetTab);
  const setDatasetReturnModelId = useUiStore((s) => s.setDatasetReturnModelId);
  const [, setTrainingJobId] = useUrlParam('trainingJobId');
  const [, setTrainingDatasetId] = useUrlParam('trainingDatasetId');
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [preview, setPreview] = useState<PreviewState>(null);
  const [showConversionWizard, setShowConversionWizard] = useState(false);
  const [jobModalId, setJobModalId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [conversionToDelete, setConversionToDelete] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: () => apiSend<{ id: string }>('DELETE', `/models/${id}`, undefined, csrfToken),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['models'] });
      onBack();
    },
  });

  const openDeleteConfirm = async () => {
    let warning = 'Delete this model? Its .pt file is removed from disk and any OpenVINO conversions are deleted.';
    try {
      const a = await apiGet<{
        training_jobs_as_base: { id: string; name: string }[];
        training_jobs_as_result: { id: string; name: string }[];
        benchmark_run_ids: string[];
      }>(`/models/${id}/associations`);
      const bits: string[] = [];
      if (a.training_jobs_as_base.length) bits.push(`used as base model by ${a.training_jobs_as_base.length} training job(s)`);
      if (a.training_jobs_as_result.length) bits.push(`is the result of ${a.training_jobs_as_result.length} training job(s)`);
      if (a.benchmark_run_ids.length) bits.push(`referenced by ${a.benchmark_run_ids.length} benchmark run(s)`);
      if (bits.length) warning += `\n\nThis model is ${bits.join(', ')}. Those records stay intact, but the model itself will be gone.`;
    } catch {
      // Associations lookup failing shouldn't block the confirm dialog; the delete
      // call itself still checks the model exists.
    }
    setDeleteConfirm(warning);
  };

  const deleteConversionMutation = useMutation({
    mutationFn: (conversionId: string) => apiSend<void>('DELETE', `/models/${id}/conversions/${conversionId}`, undefined, csrfToken),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['model-conversions', id] }),
  });

  const { data: model, isLoading, error } = useQuery({
    queryKey: ['model', id],
    queryFn: () => apiGet<ModelData>(`/models/${id}`),
    retry: (failureCount, err) => (err as ApiError).status === 404 ? false : failureCount < 3,
  });

  const trainingJob = useQuery({
    queryKey: ['model-training-job', model?.source_training_job_id],
    queryFn: () => apiGet<TrainingJobRef>(`/training-jobs/${model!.source_training_job_id}`),
    enabled: !!model?.source_training_job_id,
  });

  // Only needed to name `data=` in the reconstructed command; the worker resolves the
  // real data.yaml path itself.
  const trainingDataset = useQuery({
    queryKey: ['training-dataset-ref', trainingJob.data?.training_dataset_id],
    queryFn: () => apiGet<TrainingDatasetRef>(`/training-datasets/${trainingJob.data!.training_dataset_id}`),
    enabled: !!trainingJob.data?.training_dataset_id,
  });

  const baseModel = useQuery({
    queryKey: ['base-model-ref', trainingJob.data?.base_model_id],
    queryFn: () => apiGet<BaseModelRef>(`/models/${trainingJob.data!.base_model_id}`),
    enabled: !!trainingJob.data?.base_model_id,
  });

  const trainingArtifacts = useQuery({
    queryKey: ['training-artifacts', model?.source_training_job_id],
    queryFn: () => apiGet<Artifact[]>(`/artifacts?owner_type=TRAINING_JOB&owner_id=${model!.source_training_job_id}`),
    enabled: !!model?.source_training_job_id,
  });

  const modelArtifacts = useQuery({
    queryKey: ['model-artifacts', id],
    queryFn: () => apiGet<Artifact[]>(`/artifacts?owner_type=MODEL&owner_id=${id}`),
    enabled: !!model && model.status === 'AVAILABLE',
  });

  const conversions = useQuery({
    queryKey: ['model-conversions', id],
    queryFn: () => apiGet<ModelConversion[]>(`/models/${id}/conversions`),
    enabled: !!model,
    refetchInterval: (query) => {
      const rows = (query.state.data ?? []) as ModelConversion[];
      return rows.some((c) => c.status === 'QUEUED' || c.status === 'RUNNING') ? 2500 : false;
    },
  });
  const conversionRows = conversions.data ?? [];

  const vs = model?.validation_summary as Record<string, unknown> | undefined;
  const hasMetrics = !!vs && Object.keys(vs).length > 0;
  const trainingArts = trainingArtifacts.data ?? [];
  const chartArts = trainingArts.filter((a) => CHART_TYPES.includes(a.artifact_type_code));
  const resultsCsvArtifact = trainingArts.find((a) => a.artifact_type_code === 'RESULTS_CSV') ?? null;
  const modelArts = modelArtifacts.data ?? [];
  // The model page's artifacts are the training run's non-chart outputs (validation
  // batches, results.csv, training.log) plus anything attached to the model row.
  // The job's best.pt is the same file the model already carries, so it only shows
  // when the model row has no artifact of its own.
  const artifactRows = [
    ...modelArts,
    ...trainingArts.filter(
      (a) => !CHART_TYPES.includes(a.artifact_type_code) && !(a.artifact_type_code === 'BEST_MODEL' && modelArts.length > 0),
    ),
  ];
  const imageArts = artifactRows.filter(isImageArtifact);
  const openArtifact = (a: Artifact) => {
    if (isImageArtifact(a)) setPreview({ kind: 'image', index: imageArts.findIndex((x) => x.id === a.id) });
    else if (isTextArtifact(a)) setPreview({ kind: 'text', artifact: a });
    else window.open(`/api/v1/artifacts/${a.id}/download`, '_blank');
  };
  const hp = trainingJob.data?.hyperparameters ?? {};
  const hpEntries = Object.entries(hp).sort(([a], [b]) => a.localeCompare(b));

  // Conversion rows open the job as a floating window so the model page stays put.
  const openJob = (jobExecutionId: string) => setJobModalId(jobExecutionId);

  const openTrainingJob = () => {
    if (!model?.source_training_job_id) return;
    setTrainingReturnModelId(model.id);
    setTrainingJobId(model.source_training_job_id);
    setPage('training');
  };

  const openTrainingDataset = () => {
    if (!trainingDataset.data || !model) return;
    setDatasetReturnModelId(model.id);
    setDatasetTab('training');
    setTrainingDatasetId(trainingDataset.data.id);
    setPage('datasets');
  };

  // Trained here, so the command that produced this file can be reconstructed. A model
  // merely discovered on disk has no job behind it and gets none of this.
  const yoloCommand = trainingJob.data
    ? buildYoloCommand(hp, {
      data: trainingDataset.data?.relative_path
        ? `${trainingDataset.data.relative_path}/data.yaml`
        : trainingDataset.data?.name,
      model: baseModel.data?.original_filename ?? baseModel.data?.name ?? null,
    })
    : '';

  return (
    <section className="page">
      <div className="detail-actions">
        <button className="back-btn" onClick={onBack}>← Back</button>
      </div>

      {isLoading && <SkeletonLoader rows={5} cols={4} />}
      {error && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
          <EmptyState
            type="error"
            message={
              (error as ApiError).status === 404
                ? 'This model no longer exists or you may not have access to it.'
                : (error as Error).message
            }
          />
          <button className="btn btn-sm btn-secondary" onClick={onBack}>← Back to Models</button>
        </div>
      )}

      {model && (
        <>
          <header className="page-head">
            <div>
              <h2>{model.name}{model.version_label ? ` (${model.version_label})` : ''}</h2>
              <p className="page-sub">
                {model.task_type} · {model.source_type === 'TRAINING' ? 'Trained on this platform' : 'Discovered on disk'}
              </p>
            </div>
            <StatusBadge status={model.status} />
          </header>

          {/* Two columns on a wide screen: the facts read down the left, charts stay in
              view on the right instead of being pushed below a long parameter list. */}
          <div className={`detail-layout${chartArts.length ? '' : ' is-single'}`}>
            <div className="detail-main">
              <section className="card">
                <div className="card-title-row">
                  <h3 className="card-title">Model</h3>
                  <div className="card-title-actions">
                    {currentUserRole === 'ADMIN' && model.status === 'AVAILABLE' && (
                      <button className="btn btn-sm btn-ghost" onClick={() => setShowConversionWizard(true)}>
                        Convert to OpenVINO
                      </button>
                    )}
                    {currentUserRole === 'ADMIN' && model.status !== 'DELETED' && (
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={deleteMutation.isPending}
                        onClick={openDeleteConfirm}
                      >
                        {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
                      </button>
                    )}
                  </div>
                </div>
                <dl className="dl">
                  <div><dt>Task type</dt><dd>{model.task_type}</dd></div>
                  <div><dt>Source</dt><dd>{model.source_type}</dd></div>
                  <div><dt>File</dt><dd>{model.original_filename} ({formatBytes(model.file_size_bytes)})</dd></div>
                  <div><dt>Checksum</dt><dd><code title={model.checksum}>{model.checksum.slice(0, 16)}…</code></dd></div>
                  <div><dt>Available</dt><dd>{formatDate(model.available_at)}</dd></div>
                </dl>
              </section>

              {resultsCsvArtifact && (
                <section className="card">
                  <h3 className="card-title">Training Curves</h3>
                  <TrainingCurves artifactId={resultsCsvArtifact.id} />
                </section>
              )}

              {hasMetrics && (
                <section className="card">
                  <h3 className="card-title">Validation Metrics</h3>
                  <dl className="dl">
                    {Object.entries(vs).map(([k, v]) => (
                      <div key={k}><dt>{k}</dt><dd>{typeof v === 'number' ? v.toFixed(4) : String(v)}</dd></div>
                    ))}
                  </dl>
                </section>
              )}

              {trainingJob.data && (
                <section className="card">
                  <div className="card-title-row">
                    <h3 className="card-title">Training</h3>
                    <button className="btn btn-sm" onClick={openTrainingJob}>Open Training Job</button>
                  </div>
                  <dl className="dl">
                    <div>
                      <dt>Job</dt>
                      <dd>
                        {trainingJob.data ? (
                          <button className="link-btn" onClick={openTrainingJob} title="Open training job">
                            {trainingJob.data.name} <StatusBadge status={trainingJob.data.status} />
                          </button>
                        ) : (
                          '—'
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Dataset</dt>
                      <dd>
                        {trainingDataset.data ? (
                          <button className="link-btn" onClick={openTrainingDataset} title="Open training dataset">
                            {trainingDataset.data.name}
                          </button>
                        ) : (
                          '—'
                        )}
                      </dd>
                    </div>
                    <div><dt>Started</dt><dd>{formatDate(trainingJob.data.started_at)}</dd></div>
                    <div><dt>Finished</dt><dd>{formatDate(trainingJob.data.finished_at)}</dd></div>
                  </dl>

                  {yoloCommand && (
                    <Collapsible title="Training command">
                      <div className="cli-block">
                        <div className="cli-head">
                          <span className="cli-note">rebuilt from the stored hyperparameters</span>
                          <CopyButton text={yoloCommand} />
                        </div>
                        <pre className="cli-pre"><code>{yoloCommand}</code></pre>
                      </div>
                    </Collapsible>
                  )}

                  {hpEntries.length > 0 && (
                    <Collapsible title="Hyperparameters" count={hpEntries.length}>
                      <dl className="dl dl-compact">
                        {hpEntries.map(([k, v]) => (
                          <div key={k}><dt>{k}</dt><dd>{String(v)}</dd></div>
                        ))}
                      </dl>
                    </Collapsible>
                  )}
                </section>
              )}

              {artifactRows.length > 0 && (
                <section className="card">
                  <h3 className="card-title">Artifacts</h3>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Type</th>
                          <th>File</th>
                          <th>Size</th>
                          <th>Created</th>
                        </tr>
                      </thead>
                      <tbody>
                        {artifactRows.map((a) => (
                          <tr key={a.id}>
                            <td>{ARTIFACT_LABELS[a.artifact_type_code] ?? a.artifact_type_code}</td>
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

              {conversionRows.length > 0 && (
                <section className="card">
                  <h3 className="card-title">
                    OpenVINO Conversions
                    <span className="card-hint">click a row for job details · grab the .zip from the Download column</span>
                  </h3>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Status</th>
                          <th>Args</th>
                          <th>Created</th>
                          <th>Size</th>
                          <th>Download</th>
                          {currentUserRole === 'ADMIN' && <th></th>}
                        </tr>
                      </thead>
                      <tbody>
                        {conversionRows.map((c) => (
                          <tr
                            key={c.id}
                            style={c.job_execution_id ? { cursor: 'pointer' } : undefined}
                            onClick={() => c.job_execution_id && openJob(c.job_execution_id)}
                          >
                            <td><StatusBadge status={c.status} /></td>
                            <td>
                              <code className="cell-sub">
                                imgsz={String(c.args.imgsz ?? '—')}
                                {c.args.dynamic ? ' · dynamic' : ''}
                                {c.args.simplify ? ' · simplify' : ''}
                                {c.args.nms ? ' · nms' : ''}
                                {c.args.max_det ? ` · max_det=${c.args.max_det}` : ''}
                              </code>
                              {c.status === 'FAILED' && c.failure_message && (
                                <div className="cell-sub" style={{ color: 'var(--danger, #c0392b)' }}>{c.failure_message}</div>
                              )}
                            </td>
                            <td>{formatDate(c.created_at)}</td>
                            <td>{c.artifact_size ? formatBytes(Number(c.artifact_size)) : <span className="cell-sub">—</span>}</td>
                            <td>
                              {c.artifact_id ? (
                                <a
                                  href={`/api/v1/artifacts/${c.artifact_id}/download`}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {c.artifact_filename ?? 'Download .zip'}
                                </a>
                              ) : (
                                <span className="cell-sub">—</span>
                              )}
                            </td>
                            {currentUserRole === 'ADMIN' && (
                              <td>
                                {(c.status === 'SUCCEEDED' || c.status === 'FAILED') && (
                                  <button
                                    className="btn btn-sm btn-danger"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setConversionToDelete(c.id);
                                    }}
                                    disabled={deleteConversionMutation.isPending}
                                  >
                                    Delete
                                  </button>
                                )}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </div>

            {chartArts.length > 0 && (
              <aside className="detail-side">
                <section className="card">
                  <h3 className="card-title">
                    Training Charts
                    <span className="card-hint">click to enlarge</span>
                  </h3>
                  <ChartGrid artifacts={chartArts} onOpen={setLightbox} />
                </section>
              </aside>
            )}
          </div>
        </>
      )}

      {lightbox !== null && (
        <ChartLightbox artifacts={chartArts} index={lightbox} onNavigate={setLightbox} onClose={() => setLightbox(null)} />
      )}
      {showConversionWizard && model && (
        <ModelConversionWizard
          model={model}
          onClose={() => setShowConversionWizard(false)}
          onCreated={() => queryClient.invalidateQueries({ queryKey: ['model-conversions', id] })}
        />
      )}
      {jobModalId && <JobDetailModal id={jobModalId} onClose={() => setJobModalId(null)} />}
      {preview?.kind === 'image' && (
        <ChartLightbox
          artifacts={imageArts}
          index={preview.index}
          onNavigate={(i) => setPreview({ kind: 'image', index: i })}
          onClose={() => setPreview(null)}
        />
      )}
      {preview?.kind === 'text' && (
        <TextArtifactModal artifact={preview.artifact} onClose={() => setPreview(null)} />
      )}
      {deleteConfirm && (
        <ConfirmDialog
          title="Delete Model"
          message={deleteConfirm}
          confirmLabel="Delete"
          danger
          onCancel={() => setDeleteConfirm(null)}
          onConfirm={() => { setDeleteConfirm(null); deleteMutation.mutate(); }}
        />
      )}
      {conversionToDelete && (
        <ConfirmDialog
          title="Delete Conversion"
          message="Permanently delete this conversion and its artifact? This cannot be undone."
          confirmLabel="Delete"
          danger
          onCancel={() => setConversionToDelete(null)}
          onConfirm={() => { deleteConversionMutation.mutate(conversionToDelete); setConversionToDelete(null); }}
        />
      )}
    </section>
  );
}
