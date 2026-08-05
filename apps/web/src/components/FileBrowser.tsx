import { useState, useEffect, useCallback } from 'react';
import { apiGet } from '../lib/api';
import { Modal } from './Modal';

interface BrowseResult {
  folders: string[];
  files: string[];
  currentPath: string;
  basePath: string;
  parent: string | null;
  /** Folders that are another dataset type's root — shown, but not selectable here. */
  delegated?: { name: string; ownerName: string }[];
}

interface FileBrowserProps {
  datasetTypeId: string;
  mode?: 'folder' | 'file';
  /** Which of the dataset type's roots to browse. */
  root?: 'source' | 'training';
  value?: string;
  onSelect: (path: string, relativePath: string) => void;
  onClose: () => void;
}

export function FileBrowser({
  datasetTypeId,
  mode = 'folder',
  root = 'source',
  value,
  onSelect,
  onClose,
}: FileBrowserProps) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [currentPath, setCurrentPath] = useState('');

  const browse = useCallback(
    async (path?: string) => {
      setLoading(true);
      setSearch('');
      try {
        const qs = path ? `&path=${encodeURIComponent(path)}` : '';
        const res = await apiGet<BrowseResult>(
          `/admin/browse?dataset_type_id=${datasetTypeId}&root=${root}${qs}`,
        );
        setData(res);
        setCurrentPath(res.currentPath);
      } catch {
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [datasetTypeId, root],
  );

  useEffect(() => {
    browse(value || undefined);
  }, [browse, value]);

  function goUp() {
    if (data?.parent) browse(data.parent);
  }

  function goInto(folder: string) {
    const next = currentPath.endsWith('/')
      ? currentPath + folder
      : currentPath + '/' + folder;
    browse(next);
  }

  function selectFolder() {
    const rel = data ? makeRelative(data.basePath, currentPath) : '';
    onSelect(currentPath, rel);
    onClose();
  }

  function selectFile(filename: string) {
    const full = currentPath.endsWith('/')
      ? currentPath + filename
      : currentPath + '/' + filename;
    const rel = data ? makeRelative(data.basePath, full) : '';
    onSelect(full, rel);
    onClose();
  }

  const relativePath = data ? makeRelative(data.basePath, currentPath) : '';
  const parts = relativePath ? relativePath.split('/') : [];
  const breadcrumbs = [
    { label: shortenBase(data?.basePath), path: data?.basePath || '' },
    ...parts.map((part, i) => ({
      label: part,
      path: `${data?.basePath}/${parts.slice(0, i + 1).join('/')}`,
    })),
  ];

  const folders = search
    ? (data?.folders || []).filter((f) => f.toLowerCase().includes(search.toLowerCase()))
    : data?.folders || [];
  const files = search
    ? (data?.files || []).filter((f) => f.toLowerCase().includes(search.toLowerCase()))
    : data?.files || [];
  // Listed rather than hidden: the folder is plainly there on disk, so silently dropping
  // it would read as a broken browser instead of a deliberate boundary.
  const delegated = search
    ? (data?.delegated || []).filter((d) => d.name.toLowerCase().includes(search.toLowerCase()))
    : data?.delegated || [];

  return (
    <Modal
      title={mode === 'folder' ? 'Select Folder' : 'Select File'}
      onClose={onClose}
      footer={
        mode === 'folder' ? (
          // Dataset Manager shows the full path being selected next to the button, so
          // it is obvious what "select" will commit. Mirrored here.
          <div className="fb-foot">
            <span className="fb-foot-path" title={currentPath}>{currentPath || '—'}</span>
            <button
              className="btn btn-primary"
              style={{ width: 'auto', whiteSpace: 'nowrap' }}
              disabled={loading || !data}
              onClick={selectFolder}
            >
              Select This Folder
            </button>
          </div>
        ) : undefined
      }
    >
      <div className="fb-panel">
        <div className="fb-head">
          <div className="fb-head-actions">
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => browse(currentPath)}
              disabled={loading}
            >
              ⟳
            </button>
          </div>
        </div>

        <div className="fb-breadcrumb">
          {breadcrumbs.map((b, i) => (
            <span key={i}>
              {i > 0 && <span className="fb-sep">/</span>}
              <span className="fb-crumb" onClick={() => browse(b.path)}>
                {b.label}
              </span>
            </span>
          ))}
        </div>

        <input
          className="fb-search"
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="fb-list">
          {loading ? (
            <div className="fb-empty">Loading…</div>
          ) : (
            <>
              {/* ".." sits in the list itself, as in Dataset Manager, rather than as a
                  separate toolbar button — it is where people look for it. */}
              {data?.parent && (
                <div className="fb-item" onClick={goUp}>
                  <span className="fb-icon">↑</span>
                  <span>..</span>
                </div>
              )}
              {folders.length === 0 && files.length === 0 && delegated.length === 0 && (
                <div className="fb-empty">No items</div>
              )}
              {folders.map((f) => (
                <div key={f} className="fb-item" onClick={() => goInto(f)}>
                  <span className="fb-icon">📁</span>
                  <span>{f}</span>
                </div>
              ))}
              {delegated.map((d) => (
                <div
                  key={d.name}
                  className="fb-item is-delegated"
                  title={`This folder is the root of dataset type "${d.ownerName}" — its contents belong to that type.`}
                >
                  <span className="fb-icon">🔒</span>
                  <span>{d.name}</span>
                  <span className="fb-owner">{d.ownerName}</span>
                </div>
              ))}
              {mode === 'file' &&
                files.map((f) => (
                  <div key={f} className="fb-item" onClick={() => selectFile(f)}>
                    <span className="fb-icon">📄</span>
                    <span>{f}</span>
                  </div>
                ))}
            </>
          )}
        </div>

        {mode === 'folder' && (
          <div className="fb-current">
            <span className="fb-current-path">
              {relativePath ? `Selected: ${relativePath}` : 'Root of dataset type'}
            </span>
          </div>
        )}
      </div>
    </Modal>
  );
}

function makeRelative(basePath: string, fullPath: string): string {
  if (fullPath === basePath) return '';
  if (fullPath.startsWith(basePath + '/')) return fullPath.slice(basePath.length + 1);
  return fullPath;
}

function shortenBase(basePath?: string): string {
  if (!basePath) return 'root';
  const parts = basePath.split('/');
  return parts[parts.length - 1] || basePath;
}
