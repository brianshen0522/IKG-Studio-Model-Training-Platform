import { useQuery } from '@tanstack/react-query';
import { apiGet, ApiError } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { EmptyState } from '../components/EmptyState';
import { formatDate, formatElapsed, formatShare } from '../lib/format';
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
  class_name_warning: string | null;
  failure_code: string | null;
  failure_message: string | null;
  source_changed: boolean;
  started_at: string | null;
  finished_at: string | null;
}

interface InferenceRun {
  id: string;
  created_by_user_id: string;
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

/** Above this share of differing images the model probably does not fit the data. */
const HIGH_DIFF = 0.5;

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
            <div className="spacer" />
            <InferenceRunActions run={{ ...data, diff_image_count: totals.diff }} onDeleted={onBack} />
          </header>

          {!ACTIVE.has(data.status) && totals.processed > 0 && totals.diff / totals.processed >= HIGH_DIFF && (
            <div className="warn-banner" style={{ marginBottom: '16px' }}>
              <strong>The model disagrees with {formatShare(totals.diff, totals.processed)} of the labels.</strong>{' '}
              That is usually the model not fitting this data (trained on other footage, cameras or classes) rather
              than that many labelling mistakes. Check a few images in Compare before sending the ZIP for re-labelling.
            </div>
          )}

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
                {totals.processed.toLocaleString()} <span style={{ fontSize: 13, color: 'var(--text-sub)', fontWeight: 500 }}>/ {totals.images.toLocaleString()}</span>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-sub)', marginTop: '2px' }}>
                {data.completed_count} / {data.dataset_count} datasets done
                {data.failed_count > 0 && <span style={{ color: 'var(--red)' }}> · {data.failed_count} failed</span>}
              </div>
            </div>
            <div style={card}>
              <div style={cardLabel}>Images that differ</div>
              <div style={{ ...cardValue, color: 'var(--primary)' }}>
                {totals.diff.toLocaleString()}{' '}
                <span style={{ fontSize: 13, color: 'var(--text-sub)', fontWeight: 500 }}>
                  ({formatShare(totals.diff, totals.processed)})
                </span>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-sub)', marginTop: '2px' }}
                title="Counted in boxes, not images: one image can miss several boxes">
                Boxes: {totals.missing.toLocaleString()} missing · {totals.extra.toLocaleString()} extra · {totals.mismatch.toLocaleString()} class
              </div>
            </div>
            <div style={card}>
              <div style={cardLabel}>{ACTIVE.has(data.status) ? 'Running for' : 'Took'}</div>
              <div style={cardValue}>
                {data.started_at ? formatElapsed(data.started_at, ACTIVE.has(data.status) ? null : data.finished_at) : '—'}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-sub)', marginTop: '2px' }}>
                Started {formatDate(data.started_at)}
              </div>
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                {/* Two units in one table: images, then boxes. Without the group headers
                    372 "missing" beside 120 differing images read as a contradiction. */}
                <tr>
                  <th rowSpan={2}>Source dataset</th>
                  <th rowSpan={2}>Status</th>
                  <th colSpan={2} style={{ textAlign: 'center', borderBottom: '1px solid var(--border)' }}>Images</th>
                  <th colSpan={3} style={{ textAlign: 'center', borderBottom: '1px solid var(--border)' }}>Boxes</th>
                  <th rowSpan={2} />
                </tr>
                <tr>
                  <th style={{ minWidth: 150 }}>Processed</th>
                  <th style={{ textAlign: 'right' }}>Differ</th>
                  <th style={{ textAlign: 'right' }} title="Boxes in the original labels with no prediction over them">Missing</th>
                  <th style={{ textAlign: 'right' }} title="Predicted boxes with nothing in the original labels under them">Extra</th>
                  <th style={{ textAlign: 'right' }} title="Boxes in the same place with a different class">Class</th>
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
                        {d.class_name_warning && (
                          <div style={{ fontSize: '11px', color: 'var(--yellow)', marginTop: '2px', overflowWrap: 'anywhere' }}
                            title="The model and the source dataset have the same number of classes but name some differently. Labels are compared by class index, so check these are the same classes.">
                            ⚠ {d.class_name_warning}
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
                      <td style={{ textAlign: 'right' }}>
                        <span style={{ fontWeight: 600 }}>{d.diff_image_count.toLocaleString()}</span>
                        {d.processed_count > 0 && (
                          <span style={{ color: 'var(--text-sub)', fontSize: 11, marginLeft: 4 }}>
                            {formatShare(d.diff_image_count, d.processed_count)}
                          </span>
                        )}
                      </td>
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
