import { useQuery } from '@tanstack/react-query';
import { apiGet, ApiError } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { EmptyState } from '../components/EmptyState';
import { formatDate } from '../lib/format';
import { useUrlParam } from '../lib/urlState';
import { InferenceCompare } from '../components/InferenceCompare';
import { InferenceRunActions } from '../components/InferenceRunActions';

interface RunDataset {
  id: string;
  source_dataset_id: string;
  source_dataset_name: string | null;
  status: string;
  image_count: number;
  processed_count: number;
  diff_image_count: number;
  missing_count: number;
  extra_count: number;
  class_mismatch_count: number;
  zip_artifact_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  source_changed: boolean;
  started_at: string | null;
  finished_at: string | null;
}

interface InferenceRun {
  id: string;
  name: string;
  description: string | null;
  status: string;
  model_name: string | null;
  dataset_type_name: string | null;
  conf_threshold: number;
  iou_threshold: number;
  device: string;
  dataset_count: number;
  completed_count: number;
  failed_count: number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  datasets: RunDataset[];
}

const ACTIVE = new Set(['QUEUED', 'RUNNING', 'STOPPING']);

const card: React.CSSProperties = {
  background: 'var(--surface)', padding: '12px 16px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)',
};
const cardLabel: React.CSSProperties = { fontSize: '12px', color: 'var(--text-sub)' };
const cardValue: React.CSSProperties = { fontSize: '18px', fontWeight: 600, marginTop: '4px', color: 'var(--text)' };

export function InferenceRunDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [compareId, setCompareId] = useUrlParam('compareDatasetId');
  const { data, isLoading, error } = useQuery({
    queryKey: ['inference-run', id],
    queryFn: () => apiGet<InferenceRun>(`/inference-runs/${id}`),
    // Progress moves per chunk, which SSE does not announce (it fires on status
    // changes only), so poll while anything is still running.
    refetchInterval: (q) => (q.state.data && ACTIVE.has(q.state.data.status) ? 3000 : false),
  });

  const totals = (data?.datasets ?? []).reduce(
    (t, d) => ({
      images: t.images + d.image_count,
      processed: t.processed + d.processed_count,
      diff: t.diff + d.diff_image_count,
      missing: t.missing + d.missing_count,
      extra: t.extra + d.extra_count,
      mismatch: t.mismatch + d.class_mismatch_count,
    }),
    { images: 0, processed: 0, diff: 0, missing: 0, extra: 0, mismatch: 0 },
  );

  if (compareId) return <InferenceCompare runId={id} rdId={compareId} onBack={() => setCompareId(null)} />;

  return (
    <section className="page">
      <button className="back-btn" onClick={onBack} style={{ marginBottom: '12px', cursor: 'pointer' }}>
        ← Back to Inference
      </button>

      {isLoading && <SkeletonLoader rows={5} cols={4} />}
      {error && (
        <EmptyState
          type="error"
          message={(error as ApiError).status === 404 ? 'This inference run no longer exists.' : (error as Error).message}
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
                <p style={{ margin: '4px 0 0 0', color: 'var(--text-sub)', fontSize: '13px' }}>{data.description}</p>
              )}
            </div>
            <InferenceRunActions run={data} />
          </header>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '20px' }}>
            <div style={card}>
              <div style={cardLabel}>Model</div>
              <div style={{ ...cardValue, fontSize: '14px' }}>{data.model_name ?? '—'}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-sub)', marginTop: '2px' }}>
                {data.dataset_type_name} · conf ≥ {data.conf_threshold} · IoU {data.iou_threshold}
              </div>
            </div>
            <div style={card}>
              <div style={cardLabel}>Images processed</div>
              <div style={cardValue}>
                {totals.processed.toLocaleString()} / {totals.images.toLocaleString()}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-sub)', marginTop: '2px' }}>
                {data.completed_count} / {data.dataset_count} datasets done
                {data.failed_count > 0 && <span style={{ color: 'var(--red)' }}> · {data.failed_count} failed</span>}
              </div>
            </div>
            <div style={card}>
              <div style={cardLabel}>Images that differ</div>
              <div style={{ ...cardValue, color: 'var(--primary)' }}>{totals.diff.toLocaleString()}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-sub)', marginTop: '2px' }}>
                {totals.missing} missing · {totals.extra} extra · {totals.mismatch} class
              </div>
            </div>
            <div style={card}>
              <div style={cardLabel}>Timing</div>
              <div style={{ fontSize: '13px', fontWeight: 500, marginTop: '4px', color: 'var(--text)' }}>
                Started: {formatDate(data.started_at)}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-sub)', marginTop: '2px' }}>
                Finished: {formatDate(data.finished_at)}
              </div>
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Source dataset</th>
                  <th>Status</th>
                  <th style={{ minWidth: 160 }}>Progress</th>
                  <th style={{ textAlign: 'right' }}>Differ</th>
                  <th style={{ textAlign: 'right' }} title="Boxes in the original labels with no prediction over them">Missing</th>
                  <th style={{ textAlign: 'right' }} title="Predicted boxes with nothing in the original labels under them">Extra</th>
                  <th style={{ textAlign: 'right' }} title="Boxes in the same place with a different class">Class</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.datasets.map((d) => {
                  const pct = d.image_count > 0 ? Math.round((d.processed_count / d.image_count) * 100) : 0;
                  return (
                    <tr key={d.id}>
                      {/* Cells are nowrap app-wide; this one carries the failure message and must wrap. */}
                      <td style={{ whiteSpace: 'normal', minWidth: 220, maxWidth: 380 }}>
                        <div style={{ fontWeight: 500 }}>{d.source_dataset_name ?? d.source_dataset_id}</div>
                        {d.source_changed && (
                          <div style={{ fontSize: '11px', color: 'var(--yellow)' }}
                            title="The source dataset was rescanned after this run was created, so its files may no longer be the ones that were inferred.">
                            ⚠ source rescanned since this run
                          </div>
                        )}
                        {d.failure_message && (
                          <div style={{ fontSize: '11px', color: 'var(--red)', marginTop: '2px', overflowWrap: 'anywhere' }}>
                            {d.failure_code}: {d.failure_message}
                          </div>
                        )}
                      </td>
                      <td><StatusBadge status={d.status} /></td>
                      <td>
                        <div style={{ fontSize: '11px', color: 'var(--text-sub)', marginBottom: '3px' }}>
                          {d.processed_count.toLocaleString()} / {d.image_count.toLocaleString()}
                        </div>
                        <div style={{ height: '6px', width: '100%', backgroundColor: 'var(--surface-muted)', borderRadius: '3px', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${pct}%`, backgroundColor: 'var(--primary)', transition: 'width 0.3s ease' }} />
                        </div>
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{d.diff_image_count.toLocaleString()}</td>
                      <td style={{ textAlign: 'right' }}>{d.missing_count.toLocaleString()}</td>
                      <td style={{ textAlign: 'right' }}>{d.extra_count.toLocaleString()}</td>
                      <td style={{ textAlign: 'right' }}>{d.class_mismatch_count.toLocaleString()}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {d.diff_image_count > 0 && (
                          <button className="btn btn-sm btn-primary" style={{ marginRight: 6 }} onClick={() => setCompareId(d.id)}>
                            Compare
                          </button>
                        )}
                        {d.zip_artifact_id ? (
                          <a className="btn btn-sm btn-secondary" href={`/api/v1/artifacts/${d.zip_artifact_id}/download`}>
                            Download ZIP
                          </a>
                        ) : d.status === 'COMPLETED' && d.diff_image_count === 0 ? (
                          <span style={{ fontSize: '12px', color: 'var(--text-sub)' }}>No differences</span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
