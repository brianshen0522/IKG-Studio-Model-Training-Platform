import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet, ApiError } from '../lib/api';
import { useStopTrainingJob, useRetryTrainingJob, canStop, canRetry, stopLabel } from '../lib/trainingActions';
import { StatusBadge } from '../components/StatusBadge';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { EmptyState } from '../components/EmptyState';
import { ChartGrid, ChartLightbox, TextArtifactModal, ARTIFACT_LABELS, isImageArtifact, isTextArtifact, type ChartArtifact } from '../components/ChartViewer';
import { Collapsible } from '../components/Collapsible';
import { CopyButton } from '../components/CopyButton';
import { JobDetailModal } from '../components/JobDetailModal';
import { formatDate, formatBytes } from '../lib/format';
import { buildYoloCommand } from '@model-trainer/shared-types';
import { useUiStore } from '../stores/ui';
import { useUrlParam } from '../lib/urlState';

interface Execution {
  id: string;
  attempt_number: number;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  progress_percent: number | null;
}

interface HistoryItem {
  id: number;
  occurred_at: string;
  action_code: string;
  actor_type: string;
  actor_ref: string | null;
  actor_username: string | null;
  result: 'SUCCESS' | 'FAILURE';
}

interface Artifact extends ChartArtifact {
  owner_type_code: string;
  bucket_name: string;
  object_key: string;
  extension: string | null;
  mime_type: string;
  file_size_bytes: string;
  is_primary: boolean;
  created_at: string;
}

interface TrainingJobData {
  id: string;
  name: string;
  description: string | null;
  status: string;
  training_dataset_id: string | null;
  base_model_id: string | null;
  hyperparameters: Record<string, unknown>;
  configuration_hash: string;
  result_model_id: string | null;
  failure_stage: string | null;
  failure_code: string | null;
  failure_message: string | null;
  submitted_at: string | null;
  queued_at: string | null;
  preparing_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  executions: Execution[];
}

interface TrainingDatasetRef { id: string; name: string; relative_path: string | null }
interface ModelRef { id: string; name: string; original_filename: string | null }

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED', 'STOPPED'];
// Charts show only the two headline plots; every other artifact (PR curves, the raw
// confusion matrix, validation batches, logs, CSV) stays in the Artifacts table below,
// where each row opens a preview or download.
const CHART_TYPES = ['CONFUSION_MATRIX_NORMALIZED', 'RESULTS_IMAGE'];

/** Elapsed wall-clock for a finished run; the two timestamps alone make you do the sum. */
function duration(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function TrainingJobDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const setPage = useUiStore((s) => s.setPage);
  const setModelsReturnTrainingJobId = useUiStore((s) => s.setModelsReturnTrainingJobId);
  const [, setModelId] = useUrlParam('modelId');
  const [, setTrainingJobId] = useUrlParam('trainingJobId');
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [preview, setPreview] = useState<
    { kind: 'image'; index: number } | { kind: 'text'; artifact: Artifact } | null
  >(null);
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const stopMut = useStopTrainingJob();
  const retryMut = useRetryTrainingJob();

  const { data, isLoading, error } = useQuery({
    queryKey: ['training-job', id],
    queryFn: () => apiGet<TrainingJobData>(`/training-jobs/${id}`),
    retry: (failureCount, err) => (err as ApiError).status === 404 ? false : failureCount < 3,
    refetchInterval: (q) => {
      if (q.state.error) return false;
      const s = q.state.data?.status;
      return s && TERMINAL.includes(s) ? false : 3000;
    },
  });

  // The job row stores ids; a page showing raw UUIDs tells you nothing about which
  // dataset or weights a run actually used.
  const dataset = useQuery({
    queryKey: ['training-dataset-ref', data?.training_dataset_id],
    queryFn: () => apiGet<TrainingDatasetRef>(`/training-datasets/${data!.training_dataset_id}`),
    enabled: !!data?.training_dataset_id,
  });

  const baseModel = useQuery({
    queryKey: ['model-ref', data?.base_model_id],
    queryFn: () => apiGet<ModelRef>(`/models/${data!.base_model_id}`),
    enabled: !!data?.base_model_id,
  });

  const resultModel = useQuery({
    queryKey: ['model-ref', data?.result_model_id],
    queryFn: () => apiGet<ModelRef>(`/models/${data!.result_model_id}`),
    enabled: !!data?.result_model_id,
  });

  const artifacts = useQuery({
    queryKey: ['training-job-artifacts', id],
    queryFn: () => apiGet<Artifact[]>(`/artifacts?owner_type=TRAINING_JOB&owner_id=${id}`),
    enabled: !!data && TERMINAL.includes(data.status),
  });

  const history = useQuery({
    queryKey: ['training-job-history', id],
    queryFn: () => apiGet<HistoryItem[]>(`/training-jobs/${id}/history`),
  });

  const chartArts = artifacts.data?.filter((a) => CHART_TYPES.includes(a.artifact_type_code)) ?? [];
  const otherArts = artifacts.data?.filter((a) => !CHART_TYPES.includes(a.artifact_type_code)) ?? [];
  const imageArts = otherArts.filter(isImageArtifact);
  const openArtifact = (a: Artifact) => {
    if (isImageArtifact(a)) setPreview({ kind: 'image', index: imageArts.findIndex((x) => x.id === a.id) });
    else if (isTextArtifact(a)) setPreview({ kind: 'text', artifact: a });
    else window.open(`/api/v1/artifacts/${a.id}/download`, '_blank');
  };
  const hp = data?.hyperparameters ?? {};
  const hpEntries = Object.entries(hp).sort(([a], [b]) => a.localeCompare(b));
  const ran = duration(data?.started_at ?? null, data?.finished_at ?? null);
  const openModel = (mid: string) => {
    setModelsReturnTrainingJobId(id);
    setModelId(mid);
    setPage('models');
  };

  const yoloCommand = data
    ? buildYoloCommand(hp, {
      data: dataset.data?.relative_path ? `${dataset.data.relative_path}/data.yaml` : dataset.data?.name,
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
                ? 'This training job no longer exists or you may not have access to it.'
                : (error as Error).message
            }
          />
          <button className="btn btn-sm btn-secondary" onClick={onBack}>← Back to Training Jobs</button>
        </div>
      )}

      {data && (
        <>
          <header className="page-head">
            <div>
              <h2>{data.name}</h2>
              <p className="page-sub">
                {dataset.data?.name ?? 'Training job'}
                {ran ? ` · ran for ${ran}` : ''}
              </p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <StatusBadge status={data.status} />
              {canStop(data.status) && (
                <button
                  className="btn btn-sm btn-danger"
                  disabled={stopMut.isPending}
                  onClick={() => {
                    if (!window.confirm(`Stop "${data.name}"? This cannot be undone.`)) return;
                    stopMut.mutate(id);
                  }}
                >
                  {stopMut.isPending ? 'Stopping…' : stopLabel(data.status)}
                </button>
              )}
              {canRetry(data.status) && (
                <button
                  className="btn btn-sm btn-secondary"
                  disabled={retryMut.isPending}
                  onClick={() => {
                    retryMut.mutate(id, {
                      onSuccess: (newJob) => {
                        setTrainingJobId(newJob.id);
                      },
                    });
                  }}
                >
                  {retryMut.isPending ? 'Retrying…' : 'Retry'}
                </button>
              )}
            </div>
          </header>

          {data.failure_code && (
            <div className="error-banner">
              <strong>{data.failure_stage} · {data.failure_code}</strong>
              {data.failure_message && <div className="failure-detail">{data.failure_message}</div>}
            </div>
          )}

          {/* Same shape as the model detail page: facts down the left, charts held in
              view on the right rather than buried under the tables. */}
          <div className={`detail-layout${chartArts.length ? '' : ' is-single'}`}>
            <div className="detail-main">
              <section className="card">
                <h3 className="card-title">Run</h3>
                <dl className="dl">
                  <div><dt>Training dataset</dt><dd>{dataset.data?.name ?? (data.training_dataset_id ? '…' : '—')}</dd></div>
                  <div>
                    <dt>Base model</dt>
                    <dd>
                      {data.base_model_id ? (
                        <button className="link-btn" onClick={() => openModel(data.base_model_id!)}>
                          {baseModel.data?.name ?? '…'} →
                        </button>
                      ) : (
                        `${hp.model ?? '—'} (official weights)`
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Result model</dt>
                    <dd>
                      {data.result_model_id ? (
                        <button className="link-btn" onClick={() => openModel(data.result_model_id!)}>
                          {resultModel.data?.name ?? '…'} →
                        </button>
                      ) : (
                        '—'
                      )}
                    </dd>
                  </div>
                  <div><dt>Config hash</dt><dd><code>{data.configuration_hash.slice(0, 12)}</code></dd></div>
                  <div><dt>Submitted</dt><dd>{formatDate(data.submitted_at)}</dd></div>
                  <div><dt>Started</dt><dd>{formatDate(data.started_at)}</dd></div>
                  <div><dt>Finished</dt><dd>{formatDate(data.finished_at)}{ran ? ` (${ran})` : ''}</dd></div>
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

              <section className="card">
                <h3 className="card-title">
                  Executions
                  <span className="card-hint">{data.executions.length} attempt{data.executions.length === 1 ? '' : 's'}</span>
                </h3>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Attempt</th>
                        <th>Status</th>
                        <th>Progress</th>
                        <th>Started</th>
                        <th>Finished</th>
                        <th>Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.executions.map((e) => (
                        <tr
                          key={e.id}
                          className="row-link"
                          title="Open job details"
                          onClick={() => setOpenJobId(e.id)}
                        >
                          <td className="nums">{e.attempt_number}</td>
                          <td><StatusBadge status={e.status} /></td>
                          <td className="nums">{`${e.progress_percent ?? 0}%`}</td>
                          <td>{formatDate(e.started_at)}</td>
                          <td>{formatDate(e.finished_at)}</td>
                          <td>{e.error_code ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {otherArts.length > 0 && (
                <section className="card">
                  <h3 className="card-title">Artifacts</h3>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr><th>Type</th><th>File</th><th>Size</th><th>Created</th></tr>
                      </thead>
                      <tbody>
                        {otherArts.map((a) => (
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

              <section className="card">
                <h3 className="card-title">History</h3>
                {history.isLoading && <SkeletonLoader rows={3} cols={4} />}
                {history.data && history.data.length > 0 && (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr><th>Time</th><th>Action</th><th>Actor</th><th>Result</th></tr>
                      </thead>
                      <tbody>
                        {history.data.map((h) => (
                          <tr key={h.id}>
                            <td>{formatDate(h.occurred_at)}</td>
                            <td>{h.action_code}</td>
                            <td>{h.actor_username || h.actor_ref || h.actor_type}</td>
                            <td><StatusBadge status={h.result} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>

            {chartArts.length > 0 && (
              <aside className="detail-side">
                <section className="card">
                  <h3 className="card-title">
                    Charts
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
      {openJobId && <JobDetailModal id={openJobId} onClose={() => setOpenJobId(null)} />}
    </section>
  );
}
