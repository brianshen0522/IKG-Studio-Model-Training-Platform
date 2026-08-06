import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { useStopTrainingJob, useRetryTrainingJob } from '../lib/trainingActions';
import { toParsableIso } from '../lib/format';
import { SkeletonLoader } from './SkeletonLoader';
import { EmptyState } from './EmptyState';
import { StatusBadge } from './StatusBadge';
import { useUiStore } from '../stores/ui';
import { useUrlParam } from '../lib/urlState';

/**
 * Strip ANSI escape sequences and simulate terminal carriage-return behaviour:
 * YOLO progress bars use `\r` to overwrite the same line. Splitting each `\n`-line
 * on `\r` and keeping only the last fragment collapses hundreds of progress-bar
 * updates into one final line per output line.
 */
function sanitizeLog(t: string): string {
  return t
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-9A-Z]/g, '')
    .split('\n')
    .map((line) => line.split('\r').pop()!)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

export interface JobItem {
  id: string;
  job_type: string;
  name: string;
  business_status: string | null;
  execution_status: string;
  progress_percent: string;
  progress_message: string | null;
  task_type: string | null;
  resource_id: string;
  worker_id: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

const JOB_LABEL: Record<string, string> = {
  TRAINING: 'Training',
  DATASET_BUILD: 'Dataset Build',
  TRAINING_DATASET_SCAN: 'Dataset Validate',
  DATASET_SCAN: 'Dataset Scan',
  BENCHMARK_EVALUATION: 'Benchmark Eval',
  MODEL_INGEST: 'Model Ingest',
  MODEL_CONVERSION: 'Model Conversion',
};

const ACTIVE = ['ASSIGNED', 'CLAIMED', 'PREPARING', 'RUNNING'];

// Training/benchmark logs hang off their resource (training job / benchmark eval);
// dataset-worker logs are JOB_EXECUTION-owned so MODEL_INGEST (supports_artifacts=false
// on its resource type) still resolves them.
const OWNER_TYPE: Record<string, { type: string; ownerId: (d: JobItem) => string }> = {
  TRAINING: { type: 'TRAINING_JOB', ownerId: (d) => d.resource_id },
  BENCHMARK_EVALUATION: { type: 'BENCHMARK_EVALUATION', ownerId: (d) => d.resource_id },
  DATASET_SCAN: { type: 'JOB_EXECUTION', ownerId: (d) => d.id },
  DATASET_BUILD: { type: 'JOB_EXECUTION', ownerId: (d) => d.id },
  TRAINING_DATASET_SCAN: { type: 'JOB_EXECUTION', ownerId: (d) => d.id },
  MODEL_INGEST: { type: 'JOB_EXECUTION', ownerId: (d) => d.id },
  MODEL_CONVERSION: { type: 'MODEL_CONVERSION', ownerId: (d) => d.resource_id },
};

interface ArtifactItem {
  id: string;
  artifact_type_code: string;
  filename: string;
  created_at: string;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(toParsableIso(iso)).toLocaleString();
}

function elapsed(started: string | null, finished: string | null): string {
  const end = finished ? new Date(toParsableIso(finished)).getTime() : Date.now();
  if (!started) return '—';
  const diff = end - new Date(toParsableIso(started)).getTime();
  if (diff < 0) return '0s';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function eta(started: string | null, pct: string): string {
  if (!started || pct === '0' || pct === '100') return '—';
  const p = Number(pct);
  if (p <= 0) return '—';
  const now = Date.now();
  const start = new Date(toParsableIso(started)).getTime();
  const spent = now - start;
  if (spent <= 0) return '—';
  const total = (spent / p) * 100;
  const remaining = total - spent;
  const s = Math.floor(remaining / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function JobDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const setPage = useUiStore((s) => s.setPage);
  const [, setTrainingJobId] = useUrlParam('trainingJobId');
  const [now, setNow] = useState(Date.now());
  const stopMut = useStopTrainingJob();
  const retryMut = useRetryTrainingJob();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearInterval(iv);
    };
  }, [onClose]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['job-detail', id],
    queryFn: () => apiGet<JobItem>(`/jobs/${id}`),
    refetchInterval: (q) => {
      const s = q.state.data?.execution_status;
      return s && ACTIVE.includes(s) ? 3000 : false;
    },
  });

  const owner = data ? OWNER_TYPE[data.job_type] : undefined;
  const { data: artifacts } = useQuery({
    queryKey: ['job-artifacts', id],
    queryFn: () => apiGet<ArtifactItem[]>(`/artifacts?owner_type=${owner!.type}&owner_id=${owner!.ownerId(data!)}`),
    enabled: !!owner && !!data,
    refetchInterval: 5000,
  });
  // Multiple TRAIN_LOG rows can exist for one job: a "live" one the worker keeps
  // overwriting in MinIO while RUNNING, plus a final one written at completion —
  // always show the most recently created row.
  const logArtifact = useMemo(
    () =>
      artifacts
        ?.filter((a) => a.artifact_type_code === 'TRAIN_LOG')
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0],
    [artifacts],
  );

  const [logContent, setLogContent] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!logArtifact) return;
    let cancelled = false;
    const fetchLog = () => {
      fetch(`/api/v1/artifacts/${logArtifact.id}/view`, { credentials: 'include' })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.text();
        })
        .then((t) => {
          if (cancelled) return;
          setLogContent(sanitizeLog(t));
        })
        .catch((e) => !cancelled && setLogError((e as Error).message))
        .finally(() => !cancelled && setLogLoading(false));
    };
    setLogLoading(true);
    setLogError(null);
    fetchLog();
    // The live artifact's underlying MinIO object keeps growing while RUNNING —
    // re-fetch its content periodically instead of only once per artifact id.
    const iv = data && ACTIVE.includes(data.execution_status) ? setInterval(fetchLog, 3000) : null;
    return () => {
      cancelled = true;
      if (iv) clearInterval(iv);
    };
  }, [logArtifact, data?.execution_status]);

  // Auto-scroll to bottom when new log content arrives, unless the user scrolled up.
  useEffect(() => {
    const el = logRef.current;
    if (autoScroll && el) el.scrollTop = el.scrollHeight;
  }, [logContent, autoScroll]);

  function onLogScroll() {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
            <span className="job-tag" data-type={data?.job_type}>
              {data ? JOB_LABEL[data.job_type] ?? data.job_type : ''}
            </span>
            <h3 style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {data?.name ?? 'Job Detail'}
            </h3>
          </div>
          <button className="btn btn-ghost modal-close" onClick={onClose} aria-label="Close">×</button>
          {data?.job_type === 'TRAINING' && data.resource_id && ACTIVE.includes(data.execution_status) && (
            <button
              className="btn btn-sm btn-danger"
              disabled={stopMut.isPending}
              onClick={() => {
                if (!window.confirm(`Stop "${data.name}"? This cannot be undone.`)) return;
                stopMut.mutate(data.resource_id);
              }}
            >
              {stopMut.isPending ? 'Stopping…' : 'Stop'}
            </button>
          )}
          {data?.job_type === 'TRAINING' && data.resource_id && !ACTIVE.includes(data.execution_status) && data.execution_status !== 'SUCCEEDED' && (
            <button
              className="btn btn-sm btn-secondary"
              disabled={retryMut.isPending}
              onClick={() => {
                retryMut.mutate(data.resource_id, {
                  onSuccess: () => onClose(),
                });
              }}
            >
              {retryMut.isPending ? 'Retrying…' : 'Retry'}
            </button>
          )}
          {data?.job_type === 'TRAINING' && data.resource_id && (
            <button
              className="btn btn-sm"
              onClick={() => {
                setTrainingJobId(data.resource_id);
                setPage('training');
                onClose();
              }}
            >
              Open in Training
            </button>
          )}
        </div>

        <div className="modal-body">
          {isLoading && <SkeletonLoader rows={5} cols={4} />}
          {error && <EmptyState type="error" message={(error as Error).message} />}

          {data && (
            <>
              <div className="job-status-row">
                <StatusBadge status={data.execution_status} />
                {data.business_status && data.business_status !== data.execution_status && (
                  <span className="cell-sub" style={{ marginLeft: 8 }}>
                    Business: <StatusBadge status={data.business_status} />
                  </span>
                )}
              </div>

              <div className="job-progress-section">
                <div className="job-progress-bar-track">
                  <div
                    className="job-progress-bar-fill"
                    style={{ width: `${data.execution_status === 'SUCCEEDED' ? 100 : Math.min(Number(data.progress_percent) || 0, 100)}%` }}
                  />
                </div>
                <span className="job-progress-pct">
                  {data.execution_status === 'SUCCEEDED' ? '100%'
                    : `${Math.round(Number(data.progress_percent) || 0)}%`}
                </span>
              </div>

              <div className="job-timing">
                <div className="job-timing-item">
                  <span className="job-timing-label">Created</span>
                  <span className="job-timing-value">{fmtDate(data.created_at)}</span>
                </div>
                <div className="job-timing-item">
                  <span className="job-timing-label">Started</span>
                  <span className="job-timing-value">{fmtDate(data.started_at)}</span>
                </div>
                <div className="job-timing-item">
                  <span className="job-timing-label">Duration</span>
                  <span className="job-timing-value">{elapsed(data.started_at, data.finished_at)}</span>
                </div>
                {ACTIVE.includes(data.execution_status) && (
                  <div className="job-timing-item">
                    <span className="job-timing-label">ETA</span>
                    <span className="job-timing-value">{eta(data.started_at, data.progress_percent)}</span>
                  </div>
                )}
                {data.finished_at && (
                  <div className="job-timing-item">
                    <span className="job-timing-label">Finished</span>
                    <span className="job-timing-value">{fmtDate(data.finished_at)}</span>
                  </div>
                )}
                {data.worker_id && (
                  <div className="job-timing-item">
                    <span className="job-timing-label">Worker</span>
                    <span className="job-timing-value">{data.worker_id}</span>
                  </div>
                )}
              </div>

              <div className="job-log-section">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 0 6px' }}>
                  <h4 style={{ margin: 0, fontSize: 13, color: 'var(--text-sub)' }}>Log</h4>
                  {logContent && (
                    <span style={{ fontSize: 11, color: 'var(--text-sub)' }}>
                      {autoScroll ? 'Following' : 'Paused'} · {logContent.split('\n').length} lines
                    </span>
                  )}
                </div>
                <div className="job-log-content" ref={logRef} onScroll={onLogScroll}>
                  {logLoading && <div className="job-log-line">Loading log…</div>}
                  {logError && <div className="job-log-line job-log-error">{logError}</div>}
                  {/* The <pre> sets no height cap or overflow: .job-log-content is the
                      scroll container. Capping it here too made a second, taller scroller
                      nested inside the first, so the log showed two scrollbars. */}
                  {logContent && (
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12 }}>
                      {logContent}
                    </pre>
                  )}
                  {!logLoading && !logError && !logContent && data.progress_message && (
                    <div className="job-log-line">{data.progress_message}</div>
                  )}
                  {!logLoading && !logError && !logContent && data.error_message && (
                    <div className="job-log-line job-log-error">{data.error_message}</div>
                  )}
                  {!logLoading && !logError && !logContent && !data.progress_message && !data.error_message && data.execution_status !== 'RUNNING' && (
                    <div className="job-log-line job-log-empty">No log messages.</div>
                  )}
                  {!logContent && data.execution_status === 'SUCCEEDED' && (
                    <div className="job-log-line job-log-success">Job completed successfully.</div>
                  )}
                </div>
                {logContent && !autoScroll && (
                  <button
                    className="log-scroll-btn"
                    onClick={() => {
                      setAutoScroll(true);
                      const el = logRef.current;
                      if (el) el.scrollTop = el.scrollHeight;
                    }}
                  >
                    Scroll to bottom ↓
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
