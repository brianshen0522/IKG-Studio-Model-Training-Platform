import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../lib/api';

/**
 * Absolute-path folder/file picker, modelled directly on Dataset Manager's FileBrowser
 * (app/_components/FileBrowser.js): fixed-width panel, clickable breadcrumb, a filter
 * box, ".." as the first list row, and a footer showing the exact path Select commits.
 *
 * The previous implementation called /admin/browse-path, which does not exist, and
 * defaulted to /data, which stopped existing when the roots moved to host paths — so it
 * never listed anything. This one talks to /admin/browse/fs.
 */
interface BrowseResult {
  folders: string[];
  files: string[];
  currentPath: string;
  basePath: string;
  parent: string | null;
}

interface PathBrowserProps {
  onSelect: (path: string) => void;
  onClose: () => void;
  mode: 'folder' | 'file';
  title?: string;
  /** Where to open. Defaults to the server-side browse root. */
  basePath?: string;
}

export function PathBrowser({ onSelect, onClose, mode, title, basePath }: PathBrowserProps) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [currentPath, setCurrentPath] = useState(basePath ?? '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const browse = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    setSearch('');
    try {
      const qs = path ? `?path=${encodeURIComponent(path)}` : '';
      const res = await apiGet<BrowseResult>(`/admin/browse/fs${qs}`);
      setData(res);
      setCurrentPath(res.currentPath);
    } catch (e) {
      setError((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void browse(basePath || undefined); }, [browse, basePath]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function goInto(folder: string) {
    browse(currentPath.endsWith('/') ? currentPath + folder : `${currentPath}/${folder}`);
  }

  function selectFile(filename: string) {
    onSelect(currentPath.endsWith('/') ? currentPath + filename : `${currentPath}/${filename}`);
    onClose();
  }

  // Breadcrumb: the base, then one clickable segment per level below it.
  const base = data?.basePath ?? '';
  const rel = data && currentPath.startsWith(base) ? currentPath.slice(base.length).replace(/^\//, '') : '';
  const parts = rel ? rel.split('/') : [];
  const crumbs = [
    { label: base || '/', path: base },
    ...parts.map((part, i) => ({ label: part, path: `${base}/${parts.slice(0, i + 1).join('/')}` })),
  ];

  const match = (n: string) => !search || n.toLowerCase().includes(search.toLowerCase());
  const folders = (data?.folders ?? []).filter(match);
  const files = mode === 'file' ? (data?.files ?? []).filter(match) : [];

  return (
    <div className="fs-overlay" onClick={onClose}>
      <div className="fs-panel" onClick={(e) => e.stopPropagation()}>
        <div className="fs-head">
          <span className="fs-title">{title ?? (mode === 'folder' ? 'Select Folder' : 'Select File')}</span>
          <div className="fs-head-actions">
            <button className="fs-icon-btn" title="Refresh" disabled={loading} onClick={() => browse(currentPath)}>⟳</button>
            <button className="fs-icon-btn" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>

        <div className="fs-breadcrumb">
          {crumbs.map((c, i) => (
            <span key={i}>
              {i > 0 && <span className="fs-sep">/</span>}
              <button className="fs-crumb" onClick={() => browse(c.path)}>{c.label}</button>
            </span>
          ))}
        </div>

        <input
          className="fs-search"
          placeholder="Filter…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="fs-list">
          {loading && <div className="fs-empty">Loading…</div>}
          {error && <div className="fs-empty">{error}</div>}
          {!loading && !error && (
            <>
              {data?.parent && (
                <button className="fs-item" onClick={() => browse(data.parent!)}>
                  <span className="fs-icon">↑</span><span className="fs-name">..</span>
                </button>
              )}
              {folders.map((f) => (
                <button key={f} className="fs-item" onClick={() => goInto(f)}>
                  <span className="fs-icon">📁</span><span className="fs-name">{f}</span>
                </button>
              ))}
              {files.map((f) => (
                <button key={f} className="fs-item fs-file" onClick={() => selectFile(f)}>
                  <span className="fs-icon">📄</span><span className="fs-name">{f}</span>
                </button>
              ))}
              {folders.length === 0 && files.length === 0 && <div className="fs-empty">No items</div>}
            </>
          )}
        </div>

        {mode === 'folder' && (
          <div className="fs-foot">
            <span className="fs-foot-path">{currentPath || '—'}</span>
            <button className="fs-select" disabled={loading || !data} onClick={() => { onSelect(currentPath); onClose(); }}>
              Select This Folder
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
