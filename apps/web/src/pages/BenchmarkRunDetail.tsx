import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet, ApiError } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { EmptyState } from '../components/EmptyState';
import { formatDate } from '../lib/format';
import {
  ChartGrid,
  ChartLightbox,
  TextArtifactModal,
  isImageArtifact,
  isTextArtifact,
  type ChartArtifact,
} from '../components/ChartViewer';
import { useStopBenchmarkRun, useRetryBenchmarkRun, canStop, canRetry, stopLabel } from '../lib/benchmarkActions';

interface Evaluation {
  id: string;
  model_id: string;
  model_name?: string;
  training_dataset_id: string;
  training_dataset_name?: string;
  status: string;
  map50: number | null;
  map50_95: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  failure_code: string | null;
  started_at: string | null;
  finished_at: string | null;
}

interface BenchmarkRunData {
  id: string;
  name: string;
  description: string | null;
  status: string;
  evaluation_count: number;
  completed_count: number;
  failed_count: number;
  queued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  evaluations: Evaluation[];
}

const TERMINAL = ['COMPLETED', 'PARTIALLY_FAILED', 'FAILED', 'CANCELLED', 'STOPPED'];

function fmt(x: number | null): string {
  return x == null ? '—' : x.toFixed(4);
}

export function BenchmarkRunDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [viewMode, setViewMode] = useState<'matrix' | 'chart' | 'list'>('matrix');
  const [metricTab, setMetricTab] = useState<'map50' | 'f1' | 'precision' | 'recall'>('map50');
  const [search, setSearch] = useState('');
  const [stopConfirm, setStopConfirm] = useState<{ id: string; name: string } | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  // Artifact Modal State
  const [activeEvaluationId, setActiveEvaluationId] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [textArtifact, setTextArtifact] = useState<ChartArtifact | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['benchmark-run', id],
    queryFn: () => apiGet<BenchmarkRunData>(`/benchmark-runs/${id}`),
    retry: (failureCount, err) => (err as ApiError).status === 404 ? false : failureCount < 3,
    refetchInterval: (q) => {
      if (q.state.error) return false;
      const s = q.state.data?.status;
      return s && TERMINAL.includes(s) ? false : 3000;
    },
  });
  const stopMut = useStopBenchmarkRun();
  const retryMut = useRetryBenchmarkRun();

  // Query Evaluation Artifacts if an evaluation is selected
  const evaluationArtifacts = useQuery({
    queryKey: ['evaluation-artifacts', activeEvaluationId],
    queryFn: () =>
      apiGet<ChartArtifact[]>(
        `/artifacts?owner_type=BENCHMARK_EVALUATION&owner_id=${activeEvaluationId}`,
      ),
    enabled: !!activeEvaluationId,
  });

  // Extract unique models & datasets for Matrix view & Visual Chart
  const matrixData = useMemo(() => {
    if (!data) return { models: [], datasets: [], lookup: new Map<string, Evaluation>() };

    const modelMap = new Map<string, string>();
    const datasetMap = new Map<string, string>();
    const lookup = new Map<string, Evaluation>();

    for (const ev of data.evaluations) {
      const mName = ev.model_name || `Model ${ev.model_id.slice(0, 8)}`;
      const dName = ev.training_dataset_name || `Dataset ${ev.training_dataset_id.slice(0, 8)}`;
      modelMap.set(ev.model_id, mName);
      datasetMap.set(ev.training_dataset_id, dName);
      lookup.set(`${ev.model_id}_${ev.training_dataset_id}`, ev);
    }

    const models = Array.from(modelMap.entries()).map(([id, name]) => ({ id, name }));
    const datasets = Array.from(datasetMap.entries()).map(([id, name]) => ({ id, name }));

    return { models, datasets, lookup };
  }, [data]);

  // Overall best metric statistics
  const summaryStats = useMemo(() => {
    if (!data || data.evaluations.length === 0) return null;

    let bestMap50: { value: number; model: string; dataset: string } | null = null;
    let bestF1: { value: number; model: string; dataset: string } | null = null;

    for (const ev of data.evaluations) {
      if (ev.status === 'COMPLETED') {
        const mName = ev.model_name || `Model ${ev.model_id.slice(0, 8)}`;
        const dName = ev.training_dataset_name || `Dataset ${ev.training_dataset_id.slice(0, 8)}`;

        if (ev.map50 != null && (!bestMap50 || ev.map50 > bestMap50.value)) {
          bestMap50 = { value: ev.map50, model: mName, dataset: dName };
        }
        if (ev.f1 != null && (!bestF1 || ev.f1 > bestF1.value)) {
          bestF1 = { value: ev.f1, model: mName, dataset: dName };
        }
      }
    }

    return { bestMap50, bestF1 };
  }, [data]);

  const filteredEvaluations = useMemo(() => {
    if (!data) return [];
    return data.evaluations.filter((ev) => {
      const mName = ev.model_name || ev.model_id;
      const dName = ev.training_dataset_name || ev.training_dataset_id;
      const matchesSearch =
        mName.toLowerCase().includes(search.toLowerCase()) ||
        dName.toLowerCase().includes(search.toLowerCase());

      const matchesStatus =
        statusFilter === 'ALL' ||
        (statusFilter === 'COMPLETED' && ev.status === 'COMPLETED') ||
        (statusFilter === 'FAILED' && ev.status === 'FAILED') ||
        (statusFilter === 'RUNNING' && (ev.status === 'RUNNING' || ev.status === 'QUEUED'));

      return matchesSearch && matchesStatus;
    });
  }, [data, search, statusFilter]);

  const rawArtifacts = evaluationArtifacts.data ?? [];
  const imageArtifacts = rawArtifacts.filter(isImageArtifact);
  const textArtifacts = rawArtifacts.filter(isTextArtifact);

  return (
    <section className="page">
      <button className="back-btn" onClick={onBack} style={{ marginBottom: '12px', cursor: 'pointer' }}>
        ← Back to Benchmarks
      </button>

      {isLoading && <SkeletonLoader rows={5} cols={4} />}
      {error && (
        <EmptyState
          type="error"
          message={
            (error as ApiError).status === 404
              ? 'This benchmark run no longer exists or you may not have access to it.'
              : (error as Error).message
          }
        />
      )}

      {data && (
        <>
          <header className="page-head" style={{ marginBottom: '16px' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <h2 style={{ margin: 0 }}>{data.name}</h2>
                <StatusBadge status={data.status} />
              </div>
              {data.description && (
                <p style={{ margin: '4px 0 0 0', color: 'var(--text-sub)', fontSize: '13px' }}>
                  {data.description}
                </p>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {canStop(data.status) && (
                <button
                  className="btn btn-sm btn-danger"
                  disabled={stopMut.isPending}
                  onClick={() => setStopConfirm({ id: data.id, name: data.name })}
                >
                  {stopMut.isPending ? '…' : stopLabel(data.status)}
                </button>
              )}
              {canRetry(data.status) && (
                <button
                  className="btn btn-sm btn-secondary"
                  disabled={retryMut.isPending}
                  onClick={() => retryMut.mutate(data.id)}
                >
                  {retryMut.isPending ? '…' : 'Retry'}
                </button>
              )}
            </div>
          </header>

          {/* Quick Summary Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '20px' }}>
            <div style={{ background: 'var(--surface)', padding: '12px 16px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-sub)' }}>Evaluations Progress</div>
              <div style={{ fontSize: '18px', fontWeight: 600, marginTop: '4px', color: 'var(--text)' }}>
                {data.completed_count} / {data.evaluation_count}
              </div>
              {data.failed_count > 0 && (
                <div style={{ fontSize: '11px', color: 'var(--red)', marginTop: '2px' }}>
                  {data.failed_count} failed
                </div>
              )}
            </div>

            <div style={{ background: 'var(--surface)', padding: '12px 16px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-sub)' }}>Best mAP50</div>
              <div style={{ fontSize: '18px', fontWeight: 600, color: 'var(--primary)', marginTop: '4px' }}>
                {summaryStats?.bestMap50 ? summaryStats.bestMap50.value.toFixed(4) : '—'}
              </div>
              {summaryStats?.bestMap50 && (
                <div style={{ fontSize: '11px', color: 'var(--text-sub)', marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {summaryStats.bestMap50.model} on {summaryStats.bestMap50.dataset}
                </div>
              )}
            </div>

            <div style={{ background: 'var(--surface)', padding: '12px 16px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-sub)' }}>Best F1 Score</div>
              <div style={{ fontSize: '18px', fontWeight: 600, color: 'var(--green)', marginTop: '4px' }}>
                {summaryStats?.bestF1 ? summaryStats.bestF1.value.toFixed(4) : '—'}
              </div>
              {summaryStats?.bestF1 && (
                <div style={{ fontSize: '11px', color: 'var(--text-sub)', marginTop: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {summaryStats.bestF1.model} on {summaryStats.bestF1.dataset}
                </div>
              )}
            </div>

            <div style={{ background: 'var(--surface)', padding: '12px 16px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-sub)' }}>Duration / Created</div>
              <div style={{ fontSize: '13px', fontWeight: 500, marginTop: '4px', color: 'var(--text)' }}>
                Started: {formatDate(data.started_at)}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-sub)', marginTop: '2px' }}>
                Finished: {formatDate(data.finished_at)}
              </div>
            </div>
          </div>

          {/* Controls & View Switcher */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '10px' }}>
            <div style={{ display: 'flex', gap: '4px', background: 'var(--surface-muted)', padding: '3px', borderRadius: 'var(--radius)' }}>
              <button
                className={`btn btn-sm ${viewMode === 'matrix' ? 'btn-primary' : 'btn-secondary'}`}
                style={{ border: 'none' }}
                onClick={() => setViewMode('matrix')}
              >
                Matrix Table
              </button>
              <button
                className={`btn btn-sm ${viewMode === 'chart' ? 'btn-primary' : 'btn-secondary'}`}
                style={{ border: 'none' }}
                onClick={() => setViewMode('chart')}
              >
                Visual Result Chart
              </button>
              <button
                className={`btn btn-sm ${viewMode === 'list' ? 'btn-primary' : 'btn-secondary'}`}
                style={{ border: 'none' }}
                onClick={() => setViewMode('list')}
              >
                Detailed List
              </button>
            </div>

            {viewMode === 'list' && (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input
                  type="text"
                  placeholder="Filter by model/dataset..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ width: '200px' }}
                />
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  <option value="ALL">All Status</option>
                  <option value="COMPLETED">Completed</option>
                  <option value="RUNNING">Running / Queued</option>
                  <option value="FAILED">Failed</option>
                </select>
              </div>
            )}
          </div>

          {/* VIEW 1: MATRIX TABLE */}
          {viewMode === 'matrix' && (
            <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ background: 'var(--surface-muted)', width: '220px' }}>Model \ Dataset</th>
                    {matrixData.datasets.map((d) => (
                      <th key={d.id} style={{ background: 'var(--surface-muted)', textAlign: 'center', minWidth: '140px' }}>
                        {d.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrixData.models.map((m) => (
                    <tr key={m.id}>
                      <td style={{ fontWeight: 600, background: 'var(--surface-muted)' }}>{m.name}</td>
                      {matrixData.datasets.map((d) => {
                        const ev = matrixData.lookup.get(`${m.id}_${d.id}`);
                        if (!ev) {
                          return <td key={d.id} style={{ textAlign: 'center', color: 'var(--text-sub)' }}>—</td>;
                        }

                        const isBestMap50 =
                          ev.map50 != null &&
                          summaryStats?.bestMap50?.value === ev.map50;

                        return (
                          <td
                            key={d.id}
                            onClick={() => setActiveEvaluationId(ev.id)}
                            style={{
                              textAlign: 'center',
                              cursor: 'pointer',
                              background: isBestMap50 ? 'var(--blue-glow)' : 'transparent',
                              borderLeft: isBestMap50 ? '3px solid var(--primary)' : undefined,
                            }}
                            title="Click to view artifacts & details"
                          >
                            {ev.status === 'COMPLETED' ? (
                              <div>
                                <div style={{ fontWeight: 600, fontSize: '14px', color: isBestMap50 ? 'var(--brand-highlight)' : 'var(--text)' }}>
                                  mAP50: {fmt(ev.map50)}
                                </div>
                                <div style={{ fontSize: '11px', color: 'var(--text-sub)', marginTop: '2px' }}>
                                  P: {fmt(ev.precision)} · R: {fmt(ev.recall)} · F1: {fmt(ev.f1)}
                                </div>
                              </div>
                            ) : (
                              <StatusBadge status={ev.status} />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* VIEW 2: VISUAL RESULT CHART (BENCHMARK METRICS COMPARISON) */}
          {viewMode === 'chart' && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <h3 style={{ margin: 0, fontSize: '16px', color: 'var(--text)' }}>Model Metric Comparison Chart</h3>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {(['map50', 'f1', 'precision', 'recall'] as const).map((m) => (
                    <button
                      key={m}
                      className={`btn btn-sm ${metricTab === m ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setMetricTab(m)}
                    >
                      {m.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              {/* Bar Chart Visualization */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '12px' }}>
                {matrixData.models.map((m) => {
                  const evs = matrixData.datasets.map((d) => ({
                    dataset: d.name,
                    ev: matrixData.lookup.get(`${m.id}_${d.id}`),
                  }));

                  return (
                    <div key={m.id} style={{ background: 'var(--surface-muted)', padding: '14px', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                      <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '10px', color: 'var(--text)' }}>
                        {m.name}
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        {evs.map(({ dataset, ev }) => {
                          const val = ev ? (ev[metricTab] ?? 0) : 0;
                          const pct = Math.min(100, Math.max(0, Math.round(val * 100)));

                          return (
                            <div key={dataset} style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                              <div style={{ width: '150px', fontSize: '12px', color: 'var(--text-sub)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {dataset}
                              </div>
                              <div style={{ flex: 1, background: 'var(--bg)', height: '22px', borderRadius: '4px', overflow: 'hidden', position: 'relative', border: '1px solid var(--border)' }}>
                                <div
                                  style={{
                                    height: '100%',
                                    width: `${pct}%`,
                                    background: 'linear-gradient(90deg, var(--blue) 0%, var(--primary) 100%)',
                                    transition: 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                                    borderRadius: '3px',
                                  }}
                                />
                                <span style={{ position: 'absolute', right: '8px', top: '2px', fontSize: '11px', fontWeight: 600, color: 'var(--text)' }}>
                                  {ev && ev.status === 'COMPLETED' ? fmt(ev[metricTab]) : (ev?.status || 'N/A')}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* VIEW 3: DETAILED LIST */}
          {viewMode === 'list' && (
            <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)' }}>
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Training Dataset</th>
                    <th>Status</th>
                    <th>mAP50</th>
                    <th>mAP50-95</th>
                    <th>Precision</th>
                    <th>Recall</th>
                    <th>F1</th>
                    <th>Artifacts</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEvaluations.length === 0 ? (
                    <tr>
                      <td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-sub)', padding: '20px' }}>
                        No evaluations match your search/filter.
                      </td>
                    </tr>
                  ) : (
                    filteredEvaluations.map((e) => (
                      <tr key={e.id}>
                        <td style={{ fontWeight: 500 }}>{e.model_name || e.model_id}</td>
                        <td>{e.training_dataset_name || e.training_dataset_id}</td>
                        <td><StatusBadge status={e.status} /></td>
                        <td style={{ fontWeight: e.map50 ? 600 : 400 }}>{fmt(e.map50)}</td>
                        <td>{fmt(e.map50_95)}</td>
                        <td>{fmt(e.precision)}</td>
                        <td>{fmt(e.recall)}</td>
                        <td>{fmt(e.f1)}</td>
                        <td>
                          <button
                            className="btn btn-sm btn-secondary"
                            onClick={() => setActiveEvaluationId(e.id)}
                          >
                            View Charts
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* Evaluation Artifacts Drawer / Modal */}
          {activeEvaluationId && (
            <div className="modal-overlay" onClick={() => setActiveEvaluationId(null)}>
              <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '720px', width: '90%' }}>
                <div className="modal-head">
                  <h3>Evaluation Artifact Charts & Logs</h3>
                  <button className="modal-close" onClick={() => setActiveEvaluationId(null)}>×</button>
                </div>
                <div className="modal-body" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
                  {evaluationArtifacts.isLoading && <p className="hint">Loading artifacts...</p>}
                  {evaluationArtifacts.error && <p className="form-error">Failed to load artifacts.</p>}
                  {rawArtifacts.length === 0 && !evaluationArtifacts.isLoading && (
                    <p className="hint">No artifacts generated for this evaluation yet.</p>
                  )}

                  {imageArtifacts.length > 0 && (
                    <div style={{ marginBottom: '16px' }}>
                      <h4 style={{ fontSize: '14px', marginBottom: '8px', color: 'var(--text)' }}>Evaluation Chart Plots</h4>
                      <ChartGrid artifacts={imageArtifacts} onOpen={(idx) => setLightboxIndex(idx)} />
                    </div>
                  )}

                  {textArtifacts.length > 0 && (
                    <div>
                      <h4 style={{ fontSize: '14px', marginBottom: '8px', color: 'var(--text)' }}>Evaluation Files / Logs</h4>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        {textArtifacts.map((ta) => (
                          <button
                            key={ta.id}
                            className="btn btn-sm btn-secondary"
                            onClick={() => setTextArtifact(ta)}
                          >
                            📄 {ta.filename}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Lightbox for Image Artifacts */}
          {lightboxIndex !== null && imageArtifacts.length > 0 && (
            <ChartLightbox
              artifacts={imageArtifacts}
              index={lightboxIndex}
              onNavigate={(next) => setLightboxIndex(next)}
              onClose={() => setLightboxIndex(null)}
            />
          )}

          {/* Modal for Text Artifacts (e.g. CSVs or Logs) */}
          {textArtifact && (
            <TextArtifactModal
              artifact={textArtifact}
              onClose={() => setTextArtifact(null)}
            />
          )}
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
        </>
      )}
    </section>
  );
}
