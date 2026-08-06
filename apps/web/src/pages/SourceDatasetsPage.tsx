import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { EmptyState } from '../components/EmptyState';
import { formatDate } from '../lib/format';
import { useAuthStore } from '../stores/auth';
import { useUrlParam } from '../lib/urlState';
import { useUiStore } from '../stores/ui';
import { CollapsibleTypeGroup, useTypeGroupCollapse } from '../components/CollapsibleTypeGroup';
import { SourceDatasetDetailPage } from './SourceDatasetDetailPage';

interface Folder {
  sub_path: string;
  path: string;
  image_count_on_disk: number;
  registered: boolean;
  source_dataset_id: string | null;
  status: string | null;
  task_type: string | null;
  matched_pair_count: number | null;
  class_count: number | null;
  classes_source: string | null;
  last_scan_at: string | null;
}

interface TypeGroup {
  dataset_type_id: string;
  name: string;
  icon: string | null;
  color: string | null;
  dataset_path: string;
  inherited: boolean;
  reindexing: boolean;
  folders: Folder[];
}

export function SourceDatasetsPage() {
  const qc = useQueryClient();
  const csrfToken = useAuthStore((s) => s.csrfToken);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useUrlParam('sourceDatasetId');

  const { data, isLoading, error } = useQuery({
    queryKey: ['source-datasets', 'by-type'],
    refetchInterval: 5000,
    queryFn: () => apiGet<TypeGroup[]>('/source-datasets/by-type'),
  });

  const ensureMut = useMutation({
    mutationFn: (f: { dataset_type_id: string; sub_path: string; task_type?: string }) =>
      apiSend('POST', '/source-datasets/ensure', f, csrfToken),
    onSettled: () => {
      setBusy(null);
      qc.invalidateQueries({ queryKey: ['source-datasets'] });
    },
  });

  const rescanMut = useMutation({
    mutationFn: (id: string) => apiSend('POST', `/source-datasets/${id}/rescan`, undefined, csrfToken),
    onSettled: () => qc.invalidateQueries({ queryKey: ['source-datasets'] }),
  });

  const rescanTypeMut = useMutation({
    mutationFn: (id: string) => apiSend('POST', `/source-datasets/types/${id}/rescan`, undefined, csrfToken),
    onSettled: () => qc.invalidateQueries({ queryKey: ['source-datasets'] }),
  });

  const registerAllMut = useMutation({
    mutationFn: ({ id, subPaths }: { id: string; subPaths?: string[] }) =>
      apiSend('POST', `/source-datasets/types/${id}/register-all`, subPaths?.length ? { sub_paths: subPaths } : undefined, csrfToken),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: ['source-datasets'] });
      if (vars) setSelected((s) => { const next = { ...s }; delete next[vars.id]; return next; });
    },
  });

  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const toggleSelected = (typeId: string, subPath: string) => {
    setSelected((s) => {
      const cur = new Set(s[typeId] ?? []);
      if (cur.has(subPath)) cur.delete(subPath); else cur.add(subPath);
      return { ...s, [typeId]: cur };
    });
  };
  const unselectAll = (typeId: string) => {
    setSelected((s) => { const next = { ...s }; delete next[typeId]; return next; });
  };

  const [search, setSearch] = useState<Record<string, string>>({});

  const { isCollapsed, toggleGroup, toggleAll, anyCollapsed } = useTypeGroupCollapse('source', (data ?? []).map((g) => g.dataset_type_id));

  const goBack = () => {
    setSelectedId(null);
    const returnDsId = useUiStore.getState().sourceReturnTrainingDatasetId;
    useUiStore.getState().setSourceReturnTrainingDatasetId(null);
    if (returnDsId) useUiStore.getState().setDatasetTab('training');
  };

  if (selectedId) return <SourceDatasetDetailPage id={selectedId} onBack={goBack} />;

  const totalFolders = data?.reduce((n, g) => n + g.folders.length, 0) ?? 0;
  const totalRegistered = data?.reduce((n, g) => n + g.folders.filter((f) => f.registered).length, 0) ?? 0;
  const totalImages = data?.reduce(
    (n, g) => n + g.folders.reduce((m, f) => m + (f.image_count_on_disk || 0), 0),
    0,
  ) ?? 0;

  return (
    <section className="page">
      <header className="page-head">
        <h2>Source Datasets</h2>
        <p className="page-sub">
          Read-only folders on disk, discovered per dataset type. Register a folder to scan and index it.
        </p>
        <div className="spacer" />
        {data && data.length > 0 && (
          <button className="btn btn-sm btn-ghost" onClick={toggleAll}>
            {anyCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
        )}
        {data && <span className="count">{totalFolders} folders</span>}
      </header>

      {data && (
        <div className="stats-strip">
          <span className="stat-pill"><strong>{totalFolders}</strong> folders</span>
          <span className="stat-pill"><strong>{totalRegistered}</strong> registered</span>
          <span className="stat-pill"><strong>{data.length}</strong> types</span>
          {totalImages > 0 && <span className="stat-pill"><strong>{totalImages.toLocaleString()}</strong> images</span>}
        </div>
      )}

      {isLoading && <SkeletonLoader rows={3} cols={4} variant="table" />}
      {error && <EmptyState type="error" message={(error as Error).message} />}
      {data && data.length === 0 && (
        <EmptyState message="No dataset types with a base path configured." />
      )}

      {data?.map((g) => (
        <CollapsibleTypeGroup
          key={g.dataset_type_id}
          collapsed={isCollapsed(g.dataset_type_id)}
          onToggle={() => toggleGroup(g.dataset_type_id)}
          head={<>
            <span className="type-dot" style={{ background: g.color ?? 'var(--primary)' }} />
            <h3>{g.name}</h3>
            <code className="type-path">{g.dataset_path}</code>
            <span className="stat-pill">
              {g.folders.filter((f) => f.registered).length}/{g.folders.length} registered
            </span>
          </>}
        >
          <div className="type-group-actions">
            <input
              type="text"
              className="folder-search-input"
              placeholder="Filter folders…"
              value={search[g.dataset_type_id] ?? ''}
              onChange={(e) => setSearch((s) => ({ ...s, [g.dataset_type_id]: e.target.value }))}
            />
            <button
              className="btn btn-sm btn-ghost"
              disabled={rescanTypeMut.isPending || g.reindexing}
              onClick={() => rescanTypeMut.mutate(g.dataset_type_id)}
            >
              {g.reindexing || rescanTypeMut.isPending ? 'Reindexing…' : 'Rescan type'}
            </button>
            {(selected[g.dataset_type_id]?.size ?? 0) > 0 && (
              <button className="btn btn-sm btn-ghost" onClick={() => unselectAll(g.dataset_type_id)}>
                Unselect all
              </button>
            )}
            <button
              className="btn btn-sm btn-ghost"
              disabled={registerAllMut.isPending || g.folders.length === 0}
              onClick={() => registerAllMut.mutate({ id: g.dataset_type_id, subPaths: [...(selected[g.dataset_type_id] ?? [])] })}
              title={
                (selected[g.dataset_type_id]?.size ?? 0) > 0
                  ? 'Register/rescan only the selected folders'
                  : 'Register every unregistered folder and rescan every already-registered one'
              }
            >
              {registerAllMut.isPending && registerAllMut.variables?.id === g.dataset_type_id
                ? 'Scanning…'
                : (selected[g.dataset_type_id]?.size ?? 0) > 0
                  ? `Scan & register selected (${selected[g.dataset_type_id]!.size})`
                  : 'Scan & register all'}
            </button>
          </div>

          {g.folders.length === 0 ? (
            <EmptyState size="small" message="No dataset folders found under this path." />
          ) : (() => {
            const q = (search[g.dataset_type_id] ?? '').trim().toLowerCase();
            const visible = q ? g.folders.filter((f) => f.sub_path.toLowerCase().includes(q)) : g.folders;
            return visible.length === 0 ? (
              <EmptyState size="small" message="No folders match the filter." />
            ) : (
            <div className="folder-grid">
              {visible.map((f) => {
                const key = `${g.dataset_type_id}::${f.sub_path}`;
                const isBusy = busy === key || (ensureMut.isPending && ensureMut.variables?.sub_path === f.sub_path);
                return (
                  <div
                    className={`folder-card${f.registered ? ' is-registered' : ''}`}
                    key={f.sub_path}
                    onClick={f.registered && f.source_dataset_id ? () => setSelectedId(f.source_dataset_id) : undefined}
                    style={{
                      ...(f.registered ? { cursor: 'pointer' } : {}),
                      ...(g.color ? ({ '--tone-color': g.color } as React.CSSProperties) : {}),
                    }}
                  >
                    <div className="folder-card-head">
                      <input
                        type="checkbox"
                        className="folder-select-checkbox"
                        checked={selected[g.dataset_type_id]?.has(f.sub_path) ?? false}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleSelected(g.dataset_type_id, f.sub_path)}
                      />
                      <span className="folder-name">{f.sub_path}</span>
                      {f.registered && f.status && <StatusBadge status={f.status} />}
                    </div>
                    <div className="folder-images">{f.image_count_on_disk.toLocaleString()} images</div>
                    <div className="folder-meta">
                      {f.registered ? (
                        <>
                          <span>{f.matched_pair_count ?? '—'} pairs</span>
                          <span>·</span>
                          <span>{f.class_count ?? '—'} classes</span>
                        </>
                      ) : (
                        <span>not registered</span>
                      )}
                    </div>
                    {f.registered && f.classes_source === 'TYPE_FALLBACK' && (
                      <div className="folder-sub folder-sub-warn" title="No classes.txt in this folder; using the most common classes.txt among other datasets of this type">
                        ⚠ classes.txt missing — using type fallback
                      </div>
                    )}
                    {f.registered && f.last_scan_at && (
                      <div className="folder-sub">Scanned {formatDate(f.last_scan_at)}</div>
                    )}
                    <div className="folder-actions" onClick={(e) => e.stopPropagation()}>
                      {!f.registered ? (
                        <button
                          className="btn btn-sm"
                          disabled={isBusy}
                          onClick={() => {
                            setBusy(key);
                            ensureMut.mutate({ dataset_type_id: g.dataset_type_id, sub_path: f.sub_path });
                          }}
                        >
                          {isBusy ? 'Registering…' : 'Register & scan'}
                        </button>
                      ) : (
                        <button
                          className="btn btn-sm btn-ghost"
                          disabled={rescanMut.isPending || f.status === 'SCANNING'}
                          onClick={() => f.source_dataset_id && rescanMut.mutate(f.source_dataset_id)}
                        >
                          {f.status === 'SCANNING' ? 'Scanning…' : 'Rescan'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            );
          })()}
        </CollapsibleTypeGroup>
      ))}
    </section>
  );
}
