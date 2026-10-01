import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';

/**
 * Live per-GPU status for the dashboard: VRAM, SM utilization, temperature, power,
 * a ~2-minute utilization sparkline, and which job currently holds each card.
 *
 * Hand-drawn SVG, matching TrainingCurves — this repo has no charting library and
 * shouldn't gain one for two small shapes.
 *
 * Multi-GPU is the normal case, not a special case: cards are grouped by worker host
 * (`worker_key`), because Ultralytics' `device=0,1` indices are only meaningful within
 * one host. A fleet summary sits above the per-card grid.
 *
 * Every number comes from the worker's real NVML sampling. Metrics the host cannot
 * measure arrive as `null` and render as "—", never as 0%, and a worker whose heartbeat
 * has gone stale is labelled as such instead of showing frozen values as if live.
 */

interface GpuRow {
  worker_key: string;
  hostname: string;
  worker_status: string;
  index: number;
  uuid: string | null;
  name: string;
  memory_total_mb: number | null;
  memory_used_mb: number | null;
  memory_used_pct: number | null;
  utilization_pct: number | null;
  memory_utilization_pct: number | null;
  temperature_c: number | null;
  power_w: number | null;
  power_limit_w: number | null;
  utilization_avg_pct: number | null;
  utilization_max_pct: number | null;
  utilization_series: (number | null)[];
  memory_series: (number | null)[];
  window_s: number | null;
  supports_utilization: boolean;
  stale: boolean;
  last_heartbeat_at: string | null;
  active_jobs: { job_execution_id: string; job_type: string; job_id: string; job_name: string | null }[];
}

interface GpuOverview {
  gpus: GpuRow[];
  summary: {
    gpu_count: number;
    live_gpu_count: number;
    busy_gpu_count: number;
    utilization_avg_pct: number | null;
    memory_total_mb: number;
    memory_used_mb: number;
    memory_used_pct: number | null;
  };
}

const GB = 1024;

function gb(mb: number | null): string {
  if (mb === null) return '—';
  return `${(mb / GB).toFixed(1)} GB`;
}

/** Shared colour ramp: calm under load, amber when hot, red when saturated. */
function loadClass(pct: number | null): string {
  if (pct === null) return '';
  if (pct >= 90) return ' crit';
  if (pct >= 70) return ' warn';
  return '';
}

/** Utilization history as a filled sparkline. Gaps (nulls) break the line. */
function Sparkline({ values, width = 240, height = 34 }: {
  values: (number | null)[]; width?: number; height?: number;
}) {
  const pts = values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v !== null);
  if (pts.length < 2) {
    return <div className="gpu-spark-empty">collecting samples…</div>;
  }
  const n = values.length;
  const x = (i: number) => (n === 1 ? 0 : (i / (n - 1)) * width);
  // Fixed 0-100 domain: a GPU idling at 3% must look idle, not auto-scaled to full height.
  const y = (v: number) => height - (Math.max(0, Math.min(100, v)) / 100) * height;
  const line = pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const area =
    `M${x(pts[0].i).toFixed(1)},${height} ` +
    pts.map((p) => `L${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ') +
    ` L${x(pts[pts.length - 1].i).toFixed(1)},${height} Z`;
  return (
    <svg className="gpu-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"
         role="img" aria-label="GPU utilization history">
      <path d={area} className="gpu-spark-area" />
      <path d={line} className="gpu-spark-line" />
    </svg>
  );
}

/** Horizontal meter with a percentage label. */
function Meter({ label, pct, detail }: { label: string; pct: number | null; detail: string }) {
  const known = pct !== null;
  return (
    <div className="gpu-meter">
      <div className="gpu-meter-head">
        <span className="gpu-meter-label">{label}</span>
        <span className="gpu-meter-pct">{known ? `${pct.toFixed(0)}%` : '—'}</span>
      </div>
      <div className="gpu-meter-track">
        {known && (
          <div className={`gpu-meter-fill${loadClass(pct)}`} style={{ width: `${Math.min(100, pct)}%` }} />
        )}
      </div>
      <div className="gpu-meter-detail">{detail}</div>
    </div>
  );
}

function GpuCard({ g }: { g: GpuRow }) {
  const busy = g.active_jobs.length > 0;
  return (
    <div className={`gpu-card${g.stale ? ' stale' : ''}${busy ? ' busy' : ''}`}>
      <div className="gpu-card-head">
        <div className="gpu-card-id">
          <span className="gpu-badge">GPU {g.index}</span>
          <span className="gpu-name" title={g.uuid ?? undefined}>{g.name}</span>
        </div>
        <span className={`gpu-state${busy ? ' busy' : ''}${g.stale ? ' stale' : ''}`}>
          {g.stale ? 'No heartbeat' : busy ? 'Busy' : 'Idle'}
        </span>
      </div>

      {g.supports_utilization ? (
        <Meter
          label="GPU utilization"
          pct={g.stale ? null : g.utilization_pct}
          detail={
            g.stale
              ? 'worker stopped reporting'
              : g.utilization_avg_pct !== null
                ? `avg ${g.utilization_avg_pct.toFixed(0)}% · peak ${g.utilization_max_pct ?? 0}%` +
                  (g.window_s ? ` over ${g.window_s}s` : '')
                : 'no samples yet'
          }
        />
      ) : (
        // Being explicit beats a 0% bar that reads as a real idle measurement.
        <div className="gpu-meter">
          <div className="gpu-meter-head">
            <span className="gpu-meter-label">GPU utilization</span>
            <span className="gpu-meter-pct">—</span>
          </div>
          <div className="gpu-meter-track" />
          <div className="gpu-meter-detail">
            not measurable (NVML unavailable on this worker)
          </div>
        </div>
      )}

      <Meter
        label="VRAM"
        pct={g.stale ? null : g.memory_used_pct}
        detail={
          g.stale
            ? 'worker stopped reporting'
            : `${gb(g.memory_used_mb)} / ${gb(g.memory_total_mb)}`
        }
      />

      {g.supports_utilization && !g.stale && (
        <Sparkline values={g.utilization_series} />
      )}

      <dl className="gpu-facts">
        <div>
          <dt>Temp</dt>
          <dd>{g.temperature_c !== null && !g.stale ? `${g.temperature_c}°C` : '—'}</dd>
        </div>
        <div>
          <dt>Power</dt>
          <dd>
            {g.power_w !== null && !g.stale
              ? `${g.power_w.toFixed(0)}${g.power_limit_w ? ` / ${g.power_limit_w.toFixed(0)}` : ''} W`
              : '—'}
          </dd>
        </div>
        <div>
          <dt>Host</dt>
          <dd title={g.worker_key}>{g.hostname}</dd>
        </div>
      </dl>

      {busy && (
        <ul className="gpu-jobs">
          {g.active_jobs.map((j) => (
            <li key={j.job_execution_id}>
              <span className="gpu-job-type">{j.job_type === 'TRAINING' ? 'Training' : 'Benchmark'}</span>
              <span className="gpu-job-name">{j.job_name ?? j.job_id}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function GpuStatusPanel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard-gpu'],
    queryFn: () => apiGet<GpuOverview>('/dashboard/gpu'),
    // Workers publish on a ~15s heartbeat; 5s keeps the panel responsive without
    // polling faster than the data can actually change.
    refetchInterval: 5000,
  });

  // A box with no NVIDIA GPU is a supported configuration (CPU training), so absence
  // is stated plainly rather than rendered as an error.
  if (error) {
    return (
      <div className="gpu-panel-note">
        GPU status unavailable: {(error as Error).message}
      </div>
    );
  }
  if (isLoading) return <div className="gpu-panel-note">Loading GPU status…</div>;
  if (!data || data.gpus.length === 0) {
    return (
      <div className="gpu-panel-note">
        No GPUs reported. Training runs on CPU, or no training worker is online.
      </div>
    );
  }

  const { summary } = data;
  // Group by host so multi-GPU hosts read as one machine.
  const byWorker = new Map<string, GpuRow[]>();
  for (const g of data.gpus) {
    const list = byWorker.get(g.worker_key) ?? [];
    list.push(g);
    byWorker.set(g.worker_key, list);
  }
  const multiHost = byWorker.size > 1;

  return (
    <div className="gpu-panel">
      <div className="gpu-summary">
        <div className="gpu-sum-item">
          <span className="gpu-sum-num">{summary.gpu_count}</span>
          <span className="gpu-sum-label">GPUs</span>
        </div>
        <div className="gpu-sum-item">
          <span className="gpu-sum-num">{summary.busy_gpu_count}</span>
          <span className="gpu-sum-label">Busy</span>
        </div>
        <div className="gpu-sum-item">
          <span className="gpu-sum-num">
            {summary.utilization_avg_pct !== null ? `${summary.utilization_avg_pct.toFixed(0)}%` : '—'}
          </span>
          <span className="gpu-sum-label">Avg utilization</span>
        </div>
        <div className="gpu-sum-item">
          <span className="gpu-sum-num">
            {summary.memory_used_pct !== null ? `${summary.memory_used_pct.toFixed(0)}%` : '—'}
          </span>
          <span className="gpu-sum-label">
            VRAM {gb(summary.memory_used_mb)} / {gb(summary.memory_total_mb)}
          </span>
        </div>
      </div>

      {[...byWorker.entries()].map(([workerKey, gpus]) => (
        <div key={workerKey} className="gpu-host-group">
          {multiHost && (
            <div className="gpu-host-head">
              {gpus[0].hostname}
              <span className="gpu-host-key">{workerKey}</span>
              <span className="gpu-host-count">{gpus.length} GPU{gpus.length > 1 ? 's' : ''}</span>
            </div>
          )}
          <div className="gpu-grid">
            {gpus.map((g) => (
              <GpuCard key={`${g.worker_key}-${g.index}`} g={g} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
