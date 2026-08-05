import { useQuery } from '@tanstack/react-query';
import { apiGetList } from '../../lib/api';
import { StatusBadge } from '../../components/StatusBadge';
import { SkeletonLoader } from '../../components/SkeletonLoader';
import { EmptyState } from '../../components/EmptyState';
import { formatDate } from '../../lib/format';

interface WorkerRow {
  worker_key: string;
  worker_type: string;
  hostname: string;
  status: string;
  python_version: string;
  torch_version: string;
  ultralytics_version: string;
  cuda_version: string;
  active_job_count: number;
  last_heartbeat_at: string;
  registered_at: string;
  disabled_at: string | null;
}

export function WorkersAdmin() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-workers'],
    queryFn: () => apiGetList<WorkerRow>('/admin/workers'),
  });

  return (
    <section className="page">
      <header className="page-head">
        <h2>Workers</h2>
      </header>

      {isLoading && <SkeletonLoader rows={5} cols={4} />}
      {error && <EmptyState type="error" message={(error as Error).message} />}
      {data && data.data.length === 0 && <EmptyState message="No workers registered." />}

      {data && data.data.length > 0 && (
        <div className="worker-list">
          {data.data.map((w) => (
            <div className="worker-card" key={w.worker_key}>
              <div className="worker-body">
                <div className="worker-head">
                  <span className="worker-key">{w.worker_key}</span>
                  <StatusBadge status={w.status} />
                </div>
                <div className="worker-sub">
                  <span>{w.worker_type}</span>
                  <span className="worker-dot">·</span>
                  <span>{w.hostname}</span>
                  <span className="worker-dot">·</span>
                  <span>{w.active_job_count} active</span>
                </div>
                <div className="worker-versions">
                  Python {w.python_version} · torch {w.torch_version} · ultralytics {w.ultralytics_version}
                  {w.cuda_version ? ` · CUDA ${w.cuda_version}` : ''}
                </div>
              </div>
              <div className="worker-meta">
                <span>Heartbeat {formatDate(w.last_heartbeat_at)}</span>
                <span>Registered {formatDate(w.registered_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
