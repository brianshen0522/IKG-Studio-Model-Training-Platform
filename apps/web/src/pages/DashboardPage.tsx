import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { EmptyState } from '../components/EmptyState';
import { formatDate } from '../lib/format';

interface SystemHealth {
  workers: { online: number; offline: number; total: number };
  active_executions: number;
  pending_outbox: number;
  dead_outbox: number;
}

interface DashboardSummary {
  totals: { source_datasets: number; training_datasets: number; models: number; training_jobs: number; benchmark_runs: number };
  models_by_status: { status: string; count: number }[];
  training_by_status: { status: string; count: number }[];
  benchmark_by_status: { status: string; count: number }[];
  active_jobs: { id: string; name: string; type: string; status: string; started_at: string | null }[];
  recent_models: { id: string; name: string; version_label: string | null; task_type: string; source_type: string; status: string; created_at: string }[];
  recent_benchmarks: { id: string; name: string; status: string; evaluation_count: number; completed_count: number; failed_count: number; created_at: string }[];
  notifications: { unread_count: number };
  recent_activities: { id: number; action_code: string; resource_type_code: string; result: string; occurred_at: string; actor_type: string }[];
  system_health: SystemHealth;
}

export function DashboardPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => apiGet<DashboardSummary>('/dashboard/summary'),
    refetchInterval: 20000,
  });

  return (
    <section className="page">
      <header className="page-head">
        <h2>Dashboard</h2>
      </header>

      {isLoading && <SkeletonLoader rows={5} cols={4} />}
      {error && <EmptyState type="error" message={(error as Error).message} />}

      {data && (
        <>
          <div className="stat-grid">
            <div className="stat-card">
              <div className="stat-num">{data.totals.source_datasets}</div>
              <div className="stat-label">Source Datasets</div>
            </div>
            <div className="stat-card">
              <div className="stat-num">{data.totals.training_datasets}</div>
              <div className="stat-label">Training Datasets</div>
            </div>
            <div className="stat-card">
              <div className="stat-num">{data.totals.models}</div>
              <div className="stat-label">Models</div>
            </div>
            <div className="stat-card">
              <div className="stat-num">{data.totals.training_jobs}</div>
              <div className="stat-label">Training Jobs</div>
            </div>
            <div className="stat-card">
              <div className="stat-num">{data.totals.benchmark_runs}</div>
              <div className="stat-label">Benchmarks</div>
            </div>
          </div>

          <h3 className="dash-h">System Health</h3>
          <div className="stat-grid">
            <div className="stat-card">
              <div className="stat-num">{data.system_health.workers.online}</div>
              <div className="stat-label">Workers Online</div>
            </div>
            <div className="stat-card">
              <div className="stat-num">{data.system_health.workers.offline}</div>
              <div className="stat-label">Workers Offline</div>
            </div>
            <div className="stat-card">
              <div className="stat-num">{data.system_health.workers.total}</div>
              <div className="stat-label">Workers Total</div>
            </div>
            <div className="stat-card">
              <div className="stat-num">{data.system_health.active_executions}</div>
              <div className="stat-label">Active Executions</div>
            </div>
            <div className="stat-card">
              <div className="stat-num">{data.system_health.pending_outbox}</div>
              <div className="stat-label">Pending Outbox</div>
            </div>
            <div className="stat-card">
              <div className="stat-num">{data.system_health.dead_outbox}</div>
              <div className="stat-label">Dead-Letter Outbox</div>
            </div>
          </div>

          <h3 className="dash-h">Active Jobs</h3>
          {data.active_jobs.length > 0 ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Started</th>
                  </tr>
                </thead>
                <tbody>
                  {data.active_jobs.map((j) => (
                    <tr key={j.id}>
                      <td className="cell-title">{j.name}</td>
                      <td>{j.type}</td>
                      <td>
                        <StatusBadge status={j.status} />
                      </td>
                      <td>{formatDate(j.started_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState size="small" message="No active jobs" />
          )}

          <div className="dash-cols">
            <div>
              <h3 className="dash-h">Recent Models</h3>
              {data.recent_models.length > 0 ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Task</th>
                        <th>Source</th>
                        <th>Status</th>
                        <th>Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recent_models.map((m) => (
                        <tr key={m.id}>
                          <td className="cell-title">{m.name}</td>
                          <td>{m.task_type}</td>
                          <td>{m.source_type}</td>
                          <td>
                            <StatusBadge status={m.status} />
                          </td>
                          <td>{formatDate(m.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState size="small" message="No recent models" />
              )}
            </div>
            <div>
              <h3 className="dash-h">Recent Benchmarks</h3>
              {data.recent_benchmarks.length > 0 ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Status</th>
                        <th>Progress</th>
                        <th>Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recent_benchmarks.map((b) => (
                        <tr key={b.id}>
                          <td className="cell-title">{b.name}</td>
                          <td>
                            <StatusBadge status={b.status} />
                          </td>
                          <td>{`${b.completed_count}/${b.evaluation_count}`}</td>
                          <td>{formatDate(b.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState size="small" message="No recent benchmarks" />
              )}
            </div>
          </div>

          <h3 className="dash-h">Recent Activity</h3>
          {data.recent_activities.length > 0 ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Resource</th>
                    <th>Result</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent_activities.map((n) => (
                    <tr key={n.id}>
                      <td>{n.action_code}</td>
                      <td>{n.resource_type_code}</td>
                      <td>{n.result}</td>
                      <td>{formatDate(n.occurred_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState size="small" message="No recent activity" />
          )}
        </>
      )}
    </section>
  );
}
