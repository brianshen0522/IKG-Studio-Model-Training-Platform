import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiGet, apiGetList, apiSend } from '../lib/api';
import { useAuthStore } from '../stores/auth';
import { queryClient } from '../lib/queryClient';
import { StatusBadge } from '../components/StatusBadge';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { EmptyState } from '../components/EmptyState';
import { ModelDetailPage } from './ModelDetailPage';
import { CollapsibleTypeGroup, useTypeGroupCollapse } from '../components/CollapsibleTypeGroup';
import { formatBytes, formatDate } from '../lib/format';
import { useUrlParam } from '../lib/urlState';
import { useUiStore } from '../stores/ui';

interface ArchMeta {
  yolo_version?: string;
  yolo_size?: string;
  /** YOLO imgsz: int means the square 640×640; a tuple is (height, width). */
  imgsz?: number | [number, number];
  epochs?: number;
  class_count?: number;
  base_weights?: string;
  ultralytics_version?: string;
}

/** Both sides of the image size, so 640 and [640, 960] read the same way. */
function imgszLabel(v: number | [number, number] | undefined): string {
  if (v == null) return '—';
  const [h, w] = Array.isArray(v) ? v : [v, v];
  return `${h} × ${w}`;
}

interface Model {
  id: string;
  name: string;
  version_label: string | null;
  dataset_type_id: string;
  task_type: string;
  source_type: string;
  status: string;
  file_size_bytes: number | null;
  architecture_metadata: ArchMeta | null;
  created_at: string;
}

interface TypeOption { id: string; name: string }

interface ScanStatus {
  status: 'RUNNING' | 'COMPLETED';
  types?: number;
  found?: number;
  registered?: number;
  backfilled?: number;
  skipped?: number;
  roots_missing?: number;
}

/**
 * The scan runs in the training worker, so POST /models/scan only says "dispatched".
 * Without waiting for the receipt the button flashes for one frame and the page looks
 * unchanged, which reads as a dead button. Cap the wait so a wedged worker still frees
 * the UI instead of spinning forever.
 */
const SCAN_POLL_MS = 700;
const SCAN_TIMEOUT_MS = 60_000;

/** Plain-language outcome, so "nothing new" is stated rather than left to be inferred. */
function scanSummary(s: ScanStatus): string {
  const found = s.found ?? 0;
  const registered = s.registered ?? 0;
  const parts = [`${found} checkpoint${found === 1 ? '' : 's'} found`];
  parts.push(registered > 0 ? `${registered} newly registered` : 'nothing new');
  if (s.backfilled) parts.push(`${s.backfilled} metadata repaired`);
  if (s.skipped) parts.push(`${s.skipped} unreadable, skipped`);
  if (s.roots_missing) parts.push(`${s.roots_missing} Model Root missing on disk`);
  return parts.join(' · ');
}

/** "YOLOv8 n" from the checkpoint, or a dash for a file with no readable metadata. */
function archLabel(m: ArchMeta | null): string {
  if (!m?.yolo_version) return '—';
  const gen = m.yolo_version.replace(/^v/, '');
  const stem = gen === '8' ? 'YOLOv8' : `YOLO${gen}`;
  return m.yolo_size ? `${stem} ${m.yolo_size}` : stem;
}

export function ModelsPage() {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  const [selectedId, setSelectedId] = useUrlParam('modelId');
  const [, setTrainingJobId] = useUrlParam('trainingJobId');

  const { data, isLoading, error } = useQuery({
    queryKey: ['models'],
    refetchInterval: 5000,
    queryFn: () => apiGetList<Model>('/models?size=200'),
  });

  const { data: types } = useQuery({
    queryKey: ['dt-options-models'],
    queryFn: () => apiGet<TypeOption[]>('/dataset-types/options'),
  });

  // Models are discovered on disk, not uploaded: this asks the training worker to walk
  // each dataset type's Model Root and register whatever it finds.
  const [pendingScan, setPendingScan] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<{ text: string; at: number } | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);

  const scan = useMutation({
    mutationFn: () =>
      apiSend<{ correlation_id: string }>('POST', '/models/scan', undefined, csrfToken),
    onMutate: () => {
      setScanResult(null);
      setScanError(null);
    },
    onSuccess: (res) => setPendingScan(res.correlation_id),
    onError: (e: Error) => setScanError(e.message),
  });

  useEffect(() => {
    if (!pendingScan) return;
    let cancelled = false;
    const deadline = Date.now() + SCAN_TIMEOUT_MS;

    const poll = async () => {
      if (cancelled) return;
      try {
        const s = await apiGet<ScanStatus>(`/models/scan-status?correlation_id=${pendingScan}`);
        if (cancelled) return;
        if (s.status === 'COMPLETED') {
          setScanResult({ text: scanSummary(s), at: Date.now() });
          setPendingScan(null);
          // The rows exist by the time the receipt is written, so refresh now rather
          // than leaving the user waiting on the 5s poll.
          queryClient.invalidateQueries({ queryKey: ['models'] });
          return;
        }
      } catch (e) {
        if (cancelled) return;
        setScanError((e as Error).message);
        setPendingScan(null);
        return;
      }
      if (Date.now() > deadline) {
        setScanError('Scan is taking longer than expected — check the training worker.');
        setPendingScan(null);
        return;
      }
      pollTimer.current = window.setTimeout(poll, SCAN_POLL_MS);
    };
    poll();

    return () => {
      cancelled = true;
      if (pollTimer.current) window.clearTimeout(pollTimer.current);
    };
  }, [pendingScan]);

  const scanning = scan.isPending || pendingScan !== null;

  const models = data?.data ?? [];
  const byType = new Map<string, Model[]>();
  for (const m of models) {
    const list = byType.get(m.dataset_type_id) ?? [];
    list.push(m);
    byType.set(m.dataset_type_id, list);
  }
  const typeName = (id: string) => types?.find((t) => t.id === id)?.name ?? 'Unknown type';
  const groups = [...byType.entries()].sort((a, b) => typeName(a[0]).localeCompare(typeName(b[0])));
  const { isCollapsed, toggleGroup, toggleAll, anyCollapsed } = useTypeGroupCollapse('models', groups.map(([id]) => id));

  const goBack = () => {
    setSelectedId(null);
    const returnJobId = useUiStore.getState().modelsReturnTrainingJobId;
    useUiStore.getState().setModelsReturnTrainingJobId(null);
    if (returnJobId) {
      setTrainingJobId(returnJobId);
      useUiStore.getState().setPage('training');
    }
  };

  if (selectedId) return <ModelDetailPage id={selectedId} onBack={goBack} />;

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h2>Models</h2>
          <p className="page-sub">
            Discovered by scanning each dataset type&apos;s Model Root. Drop a <code>.pt</code> in and rescan.
          </p>
        </div>
        <div className="spacer" />
        {groups.length > 0 && (
          <button className="btn btn-sm btn-ghost" onClick={toggleAll}>
            {anyCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
        )}
        <button className="btn btn-sm btn-primary" disabled={scanning} onClick={() => scan.mutate()}>
          {scanning ? 'Scanning…' : 'Scan Model Roots'}
        </button>
      </header>

      {scanError && <div className="error-banner">{scanError}</div>}
      {/* Keyed on the finish time so two identical results still animate — otherwise a
          second scan that changes nothing looks like the button did nothing. */}
      {scanResult && (
        <div className="success-banner" key={scanResult.at}>
          Scan complete — {scanResult.text}.
        </div>
      )}

      {isLoading && <SkeletonLoader rows={5} cols={6} />}
      {error && <EmptyState type="error" message={(error as Error).message} />}
      {data && models.length === 0 && (
        <EmptyState message="No models found. Put a .pt file under a dataset type's Model Root, then Scan Model Roots." />
      )}

      {groups.map(([typeId, list]) => (
        <CollapsibleTypeGroup
          key={typeId}
          collapsed={isCollapsed(typeId)}
          onToggle={() => toggleGroup(typeId)}
          head={<><h3>{typeName(typeId)}</h3><span className="count">{list.length} model{list.length === 1 ? '' : 's'}</span></>}
        >
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Architecture</th>
                  <th>Task</th>
                  <th>imgsz</th>
                  <th>Classes</th>
                  <th>Status</th>
                  <th>Size</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {list.map((m) => {
                  const a = m.architecture_metadata;
                  return (
                    <tr key={m.id} onClick={() => setSelectedId(m.id)} style={{ cursor: 'pointer' }}>
                      <td>
                        <div className="cell-title">
                          {m.name}
                          {m.source_type === 'TRAINING' && <span className="origin-tag origin-tag-trained">Trained here</span>}
                        </div>
                        {a?.base_weights && <div className="cell-sub">from {a.base_weights}</div>}
                      </td>
                      <td>{archLabel(a ?? null)}</td>
                      <td>{m.task_type}</td>
                      {/* The image size a model was trained at decides whether two models
                          are comparable, so it earns a column rather than a detail page. */}
                      <td className="nums">{imgszLabel(a?.imgsz)}</td>
                      <td className="nums">{a?.class_count ?? '—'}</td>
                      <td><StatusBadge status={m.status} /></td>
                      <td className="nums">{formatBytes(m.file_size_bytes)}</td>
                      <td>{formatDate(m.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CollapsibleTypeGroup>
      ))}
    </section>
  );
}
