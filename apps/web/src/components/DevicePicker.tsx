import { useEffect, useState, useRef } from 'react';

interface GpuDevice {
  index: number; name: string; total_memory_mb: number; used_memory_mb: number;
}

export interface WorkerRow {
  worker_key: string; worker_type: string; hostname: string; status: string;
  cuda_version: string; active_job_count: number;
  python_version: string; torch_version: string; ultralytics_version: string;
  last_heartbeat_at: string;
  capabilities: { devices?: GpuDevice[] } | null;
}

/**
 * All GPUs across all online training workers, plus CPU, as a dropdown with a live
 * memory-usage bar per GPU. Multi-GPU (comma-separated indices) is supported for a
 * single worker only — mixing indices from different hosts doesn't mean anything to
 * Ultralytics, so toggling GPUs keeps the panel open instead of closing per click.
 */
export function DevicePicker({ workers, value, onChange }: {
  workers: WorkerRow[]; value: string; onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const online = workers.filter((w) => w.status === 'ONLINE' && w.worker_type === 'TRAINING');
  const gpus = online.flatMap((w) => (w.capabilities?.devices ?? []).map((d) => ({ w, d })));
  const selectedIndices = value && value !== 'cpu' ? value.split(',').map((v) => v.trim()) : [];

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  function toggleGpu(idx: number) {
    const idxStr = String(idx);
    if (value === 'cpu' || value === '') { onChange(idxStr); return; }
    const cur = value.split(',').map((v) => v.trim());
    if (cur.includes(idxStr)) {
      onChange(cur.filter((v) => v !== idxStr).join(','));
    } else {
      onChange([...cur, idxStr].sort().join(','));
    }
  }

  let summary = 'Auto-detect';
  if (value === 'cpu') summary = 'CPU';
  else if (selectedIndices.length === 1) {
    const g = gpus.find(({ d }) => String(d.index) === selectedIndices[0]);
    summary = g ? `GPU ${g.d.index} — ${g.d.name}` : `GPU ${selectedIndices[0]}`;
  } else if (selectedIndices.length > 1) summary = `${selectedIndices.length} GPUs (device=${value})`;

  return (
    <div ref={ref} className="device-picker">
      <button type="button" className="device-trigger" onClick={() => setOpen((o) => !o)}>
        <span>{summary}</span>
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none" style={{ opacity: 0.6, flexShrink: 0 }}>
          <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="device-panel">
          <div
            className={`device-row${value === '' ? ' selected' : ''}`}
            onClick={() => { onChange(''); setOpen(false); }}
          >
            <div className="device-row-name">Auto-detect</div>
            <div className="device-row-sub">Worker picks GPU 0 if available, else CPU</div>
          </div>
          <div
            className={`device-row${value === 'cpu' ? ' selected' : ''}`}
            onClick={() => { onChange('cpu'); setOpen(false); }}
          >
            <div className="device-row-name">CPU</div>
            <div className="device-row-sub">Slowest, always available</div>
          </div>
          {gpus.map(({ w, d }) => {
            const idxStr = String(d.index);
            const pct = d.total_memory_mb > 0 ? Math.round((d.used_memory_mb / d.total_memory_mb) * 100) : 0;
            const selected = selectedIndices.includes(idxStr);
            return (
              <div
                key={`${w.worker_key}-${d.index}`}
                className={`device-row${selected ? ' selected' : ''}`}
                onClick={() => toggleGpu(d.index)}
              >
                <div className="device-row-head">
                  <span className="device-row-name">GPU {d.index} — {d.name}</span>
                  <span className="device-row-pct">{pct}%</span>
                </div>
                <div className="device-usage-track">
                  <div
                    className={`device-usage-fill${pct >= 90 ? ' hot' : ''}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="device-row-sub">
                  {(d.used_memory_mb / 1024).toFixed(1)} / {(d.total_memory_mb / 1024).toFixed(1)} GB
                  {' · '}{w.worker_key}
                </div>
              </div>
            );
          })}
          {gpus.length === 0 && (
            <div className="device-empty">No GPUs reported by any online training worker.</div>
          )}
        </div>
      )}
      {selectedIndices.length > 1 && (
        <div className="hint" style={{ marginTop: 4 }}>
          Multi-GPU: <code>device={value}</code> — indices must all belong to the same worker host.
        </div>
      )}
    </div>
  );
}
