import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { apiGet, apiGetList } from '../lib/api';
import { useStopTrainingJob } from '../lib/trainingActions';
import { toParsableIso } from '../lib/format';
import { StatusBadge } from '../components/StatusBadge';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { EmptyState } from '../components/EmptyState';
import { JobDetailModal } from '../components/JobDetailModal';
import { InfiniteSentinel } from '../components/InfiniteSentinel';
import { Select } from '../components/Select';
import { useUiStore } from '../stores/ui';
import { useUrlParam } from '../lib/urlState';

interface JobItem {
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

interface JobTypeOption {
  code: string;
  label: string;
}

const STATUS_TABS = [
  { key: '', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Failed' },
] as const;

const EXEC_STATUS_FAILED = ['FAILED', 'CANCELLED', 'STOPPED', 'LOST'];

const TONE_COLOR: Record<string, string> = {
  SUCCEEDED: 'var(--green)',
  RUNNING: 'var(--yellow)',
  PENDING: 'var(--yellow)',
  QUEUED: 'var(--yellow)',
  STOPPING: 'var(--yellow)',
  FAILED: 'var(--red)',
  CANCELLED: 'var(--red)',
  STOPPED: 'var(--red)',
  LOST: 'var(--red)',
};

/**
 * Short labels for the narrow Type column; the modal spells them out in full.
 *
 * Must cover every code GET /jobs/types returns. The ternary chain this replaced ended in
 * a bare `: 'Ingest'`, so TRAINING_DATASET_SCAN rows were labelled "Ingest"; the fallback
 * here shows the raw code, which is ugly but not a lie.
 */
const JOB_TAG_LABEL: Record<string, string> = {
  TRAINING: 'Training',
  DATASET_BUILD: 'Build',
  TRAINING_DATASET_SCAN: 'Validate',
  DATASET_SCAN: 'Scan',
  BENCHMARK_EVALUATION: 'Benchmark',
  MODEL_INGEST: 'Ingest',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(toParsableIso(iso));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function duration(created: string, finished: string | null): string {
  const end = finished ? new Date(toParsableIso(finished)).getTime() : Date.now();
  const diff = end - new Date(toParsableIso(created)).getTime();
  if (diff < 1000) return '<1s';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

export function JobsPage() {
  // Filters live in the persisted UI store so a reload keeps them; the list itself is
  // infinite — it grows as you scroll, never a manual page switch.
  const { jobType, statusTab } = useUiStore((s) => s.jobsFilter);
  const setJobsFilter = useUiStore((s) => s.setJobsFilter);
  const [selectedId, setSelectedId] = useUrlParam('jobId');
  const stopMut = useStopTrainingJob();

  const filtersActive = jobType !== '' || statusTab !== '';
  const resetFilters = () => setJobsFilter({ jobType: '', statusTab: '' });

  const { data: typeOptions } = useQuery({
    queryKey: ['job-types'],
    queryFn: () => apiGet<JobTypeOption[]>('/jobs/types'),
    staleTime: 300000,
  });

  const params = new URLSearchParams();
  params.set('size', '25');
  if (jobType) params.set('job_type', jobType);
  if (statusTab === 'active') params.set('active', 'true');
  if (statusTab === 'completed') params.set('exec_status', 'SUCCEEDED');
  if (statusTab === 'failed') {
    for (const s of EXEC_STATUS_FAILED) params.append('exec_status', s);
  }

  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['jobs', jobType, statusTab],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(params);
      p.set('page', String(pageParam));
      return apiGetList<JobItem>(`/jobs?${p.toString()}`);
    },
    initialPageParam: 1,
    getNextPageParam: (last) => (last.meta.page < last.meta.totalPages ? last.meta.page + 1 : undefined),
    refetchInterval: 5000,
  });

  const items = data?.pages.flatMap((p) => p.data) ?? [];
  const total = data?.pages[0]?.meta.total;

  return (
    <section className="page">
      {selectedId && <JobDetailModal id={selectedId} onClose={() => setSelectedId(null)} />}

      <header className="page-head">
        <h2>Jobs</h2>
        <div className="spacer" />
        <span className="cell-sub">{total ?? '…'} total</span>
      </header>

      <div className="filters">
        <Select
          value={jobType}
          onChange={(v) => setJobsFilter({ jobType: v })}
          options={[{ value: '', label: 'All types' }, ...(typeOptions ?? []).map((t) => ({ value: t.code, label: t.label }))]}
          minWidth={160}
        />

         <div className="btn-group" style={{ gap: 4 }}>
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.key}
              className={`btn btn-sm${statusTab === tab.key ? ' btn-primary' : ''}`}
              onClick={() => setJobsFilter({ statusTab: tab.key })}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Filters persist across reloads, so there has to be a way back to "everything".
            Only rendered when something is actually filtered — a permanently visible
            Reset reads as an action that does nothing. */}
        {filtersActive && (
          <button className="btn btn-sm btn-ghost" onClick={resetFilters}>
            Reset filters
          </button>
        )}
      </div>

      {isLoading && <SkeletonLoader rows={6} variant="list" />}
      {error && <EmptyState type="error" message={(error as Error).message} />}

      {!isLoading && !error && items.length === 0 && (
        // Filters survive reloads, so an empty list is far more often a leftover filter
        // than an empty system. Say which it is.
        <EmptyState message={filtersActive ? 'No jobs match the current filters.' : 'No jobs found.'} />
      )}

      {items.length > 0 && (
        <>
        <div className="job-list">
          {items.map((item) => {
            const pct = item.execution_status === 'SUCCEEDED'
              ? 100
              : item.progress_percent && Number(item.progress_percent) > 0
                ? Math.round(Number(item.progress_percent))
                : null;
            const tone = TONE_COLOR[item.execution_status.toUpperCase()];
            return (
              <div
                key={item.id}
                className="job-card"
                onClick={() => setSelectedId(item.id)}
                style={tone ? ({ '--tone-color': tone } as React.CSSProperties) : undefined}
              >
                <span className="job-tag" data-type={item.job_type}>
                  {JOB_TAG_LABEL[item.job_type] ?? item.job_type}
                </span>
                <div className="job-card-body">
                  <div className="job-card-head">
                    <span className="job-card-name">{item.name}</span>
                    {item.task_type && <span className="job-card-sub">{item.task_type}</span>}
                    <StatusBadge status={item.execution_status} />
                    {item.job_type === 'TRAINING' && ['RUNNING', 'PREPARING', 'QUEUED', 'ASSIGNED', 'CLAIMED', 'STOPPING'].includes(item.execution_status) && (
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={stopMut.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!window.confirm(`Stop "${item.name}"? This cannot be undone.`)) return;
                          stopMut.mutate(item.resource_id);
                        }}
                      >
                        Stop
                      </button>
                    )}
                    {item.business_status && item.business_status !== item.execution_status && (
                      <span className="job-card-sub">({item.business_status})</span>
                    )}
                  </div>
                  {pct !== null && (
                    <div className="job-card-progress">
                      <div className="job-card-progress-track">
                        <div className="job-card-progress-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="job-card-progress-pct">{pct}%</span>
                    </div>
                  )}
                </div>
                <div className="job-card-meta">
                  <span>{duration(item.created_at, item.finished_at)}</span>
                  <span>{formatDate(item.created_at)}</span>
                </div>
              </div>
            );
          })}
        </div>
        <InfiniteSentinel
          hasNextPage={hasNextPage === true}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={() => fetchNextPage()}
        />
        </>
      )}
    </section>
  );
}
