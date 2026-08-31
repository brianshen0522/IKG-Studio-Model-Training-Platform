import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiGetAll, apiSend } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { EmptyState } from '../components/EmptyState';
import { formatDate } from '../lib/format';
import { useAuthStore } from '../stores/auth';
import { useUrlParam } from '../lib/urlState';
import { useUiStore } from '../stores/ui';
import { CollapsibleTypeGroup, useTypeGroupCollapse } from '../components/CollapsibleTypeGroup';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { FileBrowser } from '../components/FileBrowser';
import { MultiSelect, type MultiSelectOption } from '../components/MultiSelect';
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
  /** Registered, but its folder is no longer in the directory index — see browseByType. */
  missing_on_disk?: boolean;
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

/**
 * Archived source datasets are excluded from `by-type` (the grid is keyed on folders
 * that are still claimable), so without this they become unreachable: the detail page
 * is only linked from the grid, and training datasets list their inputs by id. Fetched
 * separately and shown read-only — archiving is one-way by design, since the folder it
 * pointed at is typically gone or re-registered by then.
 */
interface ArchivedItem {
  id: string;
  name: string;
  dataset_type_id: string;
  relative_path: string;
  archived_at: string | null;
}

const STATUS_ORDER = ['REGISTERED', 'SCANNING', 'READY', 'INVALID', 'NONE'] as const;

function statusOptionsFor(folders: Folder[]): MultiSelectOption[] {
  return STATUS_ORDER
    .filter((s) => folders.some((f) => (f.status ?? 'NONE') === s))
    .map((s) => {
      const count = folders.filter((f) => (f.status ?? 'NONE') === s).length;
      return { value: s, label: `${s === 'NONE' ? 'Not registered' : s} (${count})` };
    });
}

export function SourceDatasetsPage() {
  const qc = useQueryClient();
  const csrfToken = useAuthStore((s) => s.csrfToken);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState<{ id: string; name: string; count: number } | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<
    { typeId: string; targets: { id: string; name: string }[] } | null
  >(null);
  const [selectedId, setSelectedId] = useUrlParam('sourceDatasetId');
  const [showArchived, setShowArchived] = useState(false);
  const [browseTypeId, setBrowseTypeId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['source-datasets', 'by-type'],
    refetchInterval: 5000,
    queryFn: () => apiGet<TypeGroup[]>('/source-datasets/by-type'),
  });

  // `archived=true` on the list endpoint means "don't filter", not "only archived",
  // so narrow it here rather than adding a second server-side flag.
  const archived = useQuery({
    queryKey: ['source-datasets', 'archived'],
    enabled: showArchived,
    queryFn: async () =>
      (await apiGetAll<ArchivedItem>('/source-datasets?archived=true')).filter((d) => d.archived_at),
  });

  const archivedByType = new Map<string, ArchivedItem[]>();
  for (const d of archived.data ?? []) {
    const list = archivedByType.get(d.dataset_type_id);
    if (list) list.push(d); else archivedByType.set(d.dataset_type_id, [d]);
  }

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

  /**
   * Sequential rather than parallel: archiving is one-way, so a partial failure has to be
   * reportable per dataset instead of collapsing into one rejected Promise.all. Volumes here
   * are a handful of datasets, so the round trips cost nothing.
   */
  const archiveMut = useMutation({
    mutationFn: async (targets: { id: string; name: string }[]) => {
      const failed: string[] = [];
      for (const t of targets) {
        try {
          await apiSend('POST', `/source-datasets/${t.id}/archive`, undefined, csrfToken);
        } catch (e) {
          failed.push(`${t.name}: ${(e as Error).message}`);
        }
      }
      if (failed.length > 0) throw new Error(failed.join('; '));
    },
    onSettled: (_d, _e, vars) => {
      qc.invalidateQueries({ queryKey: ['source-datasets'] });
      if (vars && confirmArchive) unselectAll(confirmArchive.typeId);
    },
    onSuccess: () => setConfirmArchive(null),
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
  const selectAll = (typeId: string, subPaths: string[]) => {
    setSelected((s) => ({ ...s, [typeId]: new Set(subPaths) }));
  };

  const [search, setSearch] = useState<Record<string, string>>({});
  const [statusFilter, setStatusFilter] = useState<Record<string, string[]>>({});

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
        <label className="check-row" style={{ gap: 6 }} title="Archived datasets are hidden from the folder grid but remain readable">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          <span>Show archived</span>
        </label>
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
            <MultiSelect
              value={statusFilter[g.dataset_type_id] ?? []}
              options={statusOptionsFor(g.folders)}
              onChange={(v) => setStatusFilter((s) => ({ ...s, [g.dataset_type_id]: v }))}
              placeholder="Status…"
              minWidth={140}
            />
            <button
              className="btn btn-sm btn-ghost"
              disabled={rescanTypeMut.isPending || g.reindexing}
              onClick={() => rescanTypeMut.mutate(g.dataset_type_id)}
            >
              {g.reindexing || rescanTypeMut.isPending ? 'Reindexing…' : 'Rescan type'}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              title="Browse the folder tree on disk and register one dataset directly — no full reindex needed"
              onClick={() => setBrowseTypeId(g.dataset_type_id)}
            >
              Browse…
            </button>
            {(() => {
              const allSelected = g.folders.length > 0 && g.folders.every((f) => selected[g.dataset_type_id]?.has(f.sub_path));
              return (
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={g.folders.length === 0}
                  onClick={() => (allSelected
                    ? unselectAll(g.dataset_type_id)
                    : selectAll(g.dataset_type_id, g.folders.map((f) => f.sub_path)))}
                >
                  {allSelected ? 'Deselect all' : 'Select all'}
                </button>
              );
            })()}
            <button
              className="btn btn-sm btn-ghost"
              disabled={registerAllMut.isPending || g.folders.length === 0}
              onClick={() => {
                const sel = selected[g.dataset_type_id]?.size ?? 0;
                if (sel === 0 && g.folders.length > 10) {
                  setConfirmAll({ id: g.dataset_type_id, name: g.name, count: g.folders.length });
                  return;
                }
                registerAllMut.mutate({ id: g.dataset_type_id, subPaths: [...(selected[g.dataset_type_id] ?? [])] });
              }}
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
            {(() => {
              // Only registered folders have something to archive; unregistered ones in the
              // selection are ignored rather than blocking the action.
              const targets = g.folders
                .filter((f) => selected[g.dataset_type_id]?.has(f.sub_path) && f.registered && f.source_dataset_id)
                .map((f) => ({ id: f.source_dataset_id!, name: f.sub_path }));
              if (targets.length === 0) return null;
              return (
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={archiveMut.isPending}
                  onClick={() => setConfirmArchive({ typeId: g.dataset_type_id, targets })}
                >
                  Archive selected ({targets.length})
                </button>
              );
            })()}
          </div>

          {g.folders.length === 0 ? (
            <EmptyState size="small" message="No dataset folders found under this path." />
          ) : (() => {
            const q = (search[g.dataset_type_id] ?? '').trim().toLowerCase();
            const statusSel = statusFilter[g.dataset_type_id] ?? [];
            const visible = g.folders.filter((f) => {
              if (q && !f.sub_path.toLowerCase().includes(q)) return false;
              if (statusSel.length > 0 && !statusSel.includes(f.status ?? 'NONE')) return false;
              return true;
            });
            return visible.length === 0 ? (
              <EmptyState size="small" message="No folders match the filter." />
            ) : (
            <div className="folder-grid">
              {visible.map((f) => {
                const key = `${g.dataset_type_id}::${f.sub_path}`;
                const isBusy = busy === key || (ensureMut.isPending && ensureMut.variables?.sub_path === f.sub_path);
                return (
                  <div
                    className={`folder-card${f.registered ? ' is-registered' : ''}${f.missing_on_disk ? ' is-missing' : ''}`}
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
                    {f.missing_on_disk ? (
                      <div className="folder-sub folder-sub-warn" title={f.path}>
                        ⚠ folder not found on disk — the next rescan archives it (or removes it if unused)
                      </div>
                    ) : (
                      <div className="folder-images">{f.image_count_on_disk.toLocaleString()} images</div>
                    )}
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
                        <>
                          <button
                            className="btn btn-sm btn-ghost"
                            disabled={rescanMut.isPending || f.status === 'SCANNING'}
                            onClick={() => f.source_dataset_id && rescanMut.mutate(f.source_dataset_id)}
                          >
                            {f.status === 'SCANNING' ? 'Scanning…' : 'Rescan'}
                          </button>
                          <button
                            className="btn btn-sm btn-ghost"
                            disabled={f.status === 'SCANNING'}
                            title={f.status === 'SCANNING' ? 'Cannot archive while scanning' : 'Archive this dataset'}
                            onClick={() => f.source_dataset_id && setConfirmArchive({
                              typeId: g.dataset_type_id,
                              targets: [{ id: f.source_dataset_id, name: f.sub_path }],
                            })}
                          >
                            Archive
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            );
          })()}

          {showArchived && (archivedByType.get(g.dataset_type_id)?.length ?? 0) > 0 && (
            <>
              <div className="folder-archived-head">
                Archived ({archivedByType.get(g.dataset_type_id)!.length})
              </div>
              <div className="folder-grid">
                {archivedByType.get(g.dataset_type_id)!.map((d) => (
                  <div
                    className="folder-card is-archived"
                    key={d.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setSelectedId(d.id)}
                  >
                    <div className="folder-card-head">
                      <span className="folder-name">{d.name}</span>
                      <StatusBadge status="ARCHIVED" />
                    </div>
                    <div className="folder-meta"><code>{d.relative_path}</code></div>
                    {d.archived_at && (
                      <div className="folder-sub">Archived {formatDate(d.archived_at)}</div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
          </CollapsibleTypeGroup>
      ))}

      {confirmArchive && (
        <ConfirmDialog
          title={confirmArchive.targets.length === 1 ? 'Archive dataset' : `Archive ${confirmArchive.targets.length} datasets`}
          message={
            (confirmArchive.targets.length === 1
              ? `Archive "${confirmArchive.targets[0].name}"? Nothing on disk is touched — the dataset is hidden from the folder grid and can no longer be used for new training datasets.`
              : `Archive ${confirmArchive.targets.length} datasets? Nothing on disk is touched — they are hidden from the folder grid and can no longer be used for new training datasets.`)
            + '\n\nArchiving is one-way. To use these folders again, register them afresh.'
          }
          confirmLabel={archiveMut.isPending ? 'Archiving…' : 'Archive'}
          danger
          error={archiveMut.error ? (archiveMut.error as Error).message : null}
          confirmDisabled={archiveMut.isPending}
          onCancel={() => { archiveMut.reset(); setConfirmArchive(null); }}
          onConfirm={() => archiveMut.mutate(confirmArchive.targets)}
        />
      )}

      {confirmAll && (
        <ConfirmDialog
          title="Scan & register all"
          message={`Scanning all ${confirmAll.count} folders for "${confirmAll.name}" will take a long time. Continue?`}
          confirmLabel="Scan all"
          onCancel={() => setConfirmAll(null)}
          onConfirm={() => {
            const c = confirmAll;
            setConfirmAll(null);
            registerAllMut.mutate({ id: c.id });
          }}
        />
      )}

      {browseTypeId && (() => {
        // Already-registered folders are greyed out in the browser — the point of this
        // flow is registering ONE new folder straight from disk, no reindex needed.
        const grp = (data ?? []).find((g) => g.dataset_type_id === browseTypeId);
        const disabled: Record<string, string> = {};
        for (const f of grp?.folders ?? []) {
          if (f.registered) disabled[f.sub_path] = 'Already registered';
        }
        return (
          <FileBrowser
            datasetTypeId={browseTypeId}
            root="source"
            title="Register a Source Dataset"
            selectLabel="Register & scan"
            disableRootSelect
            disabledPaths={disabled}
            onSelect={(_abs, rel) => {
              if (rel) ensureMut.mutate({ dataset_type_id: browseTypeId, sub_path: rel });
            }}
            onClose={() => setBrowseTypeId(null)}
          />
        );
      })()}
    </section>
  );
}
