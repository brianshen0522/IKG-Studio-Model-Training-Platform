import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiSend, ApiError } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { EmptyState } from '../components/EmptyState';
import { PathDisplay } from '../components/PathDisplay';
import { DatasetPreviewPanel } from '../components/DatasetPreviewPanel';
import { formatDate } from '../lib/format';
import { useAuthStore } from '../stores/auth';
import { ConfirmDialog } from '../components/ConfirmDialog';

const CLASS_COLLAPSE_THRESHOLD = 8;

interface SourceDatasetData {
  id: string;
  name: string;
  dataset_type_id: string;
  task_type: string;
  relative_path: string;
  sub_path: string | null;
  images_relative_path: string;
  labels_relative_path: string;
  classes_file_relative_path: string | null;
  allow_subdirectories: boolean;
  notes: string | null;
  status: string;
  latest_scan_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  manual_classes_override: string[] | null;
  latest_scan: ScanData | null;
}

interface ScanData {
  id: string;
  status: string;
  scan_version: number;
  started_at: string | null;
  finished_at: string | null;
  image_count: number;
  label_count: number;
  matched_pair_count: number;
  missing_image_count: number;
  missing_label_count: number;
  invalid_label_count: number;
  ignored_file_count: number;
  empty_label_count: number;
  warning_count: number;
  error_count: number;
  class_count: number;
  classes_hash: string | null;
  classes_source: string | null;
  error_code: string | null;
  error_message: string | null;
}

interface ClassItem {
  class_index: number;
  class_name: string;
  source: string;
  object_count: number;
}

interface IssueItem {
  id: string;
  severity: string;
  issue_code: string;
  image_relative_path: string | null;
  label_relative_path: string | null;
  line_number: number | null;
  created_at: string;
}

// The source folder is read-only so a manual class list is never written to disk —
// it's stored on the row and the scanner treats it as the highest-priority classes
// source, replacing even an on-disk classes.txt when set.
const OVERRIDABLE_SOURCES = new Set(['CLASSES_FILE', 'LABEL_INFERENCE', 'TYPE_FALLBACK', 'MANUAL_OVERRIDE', null]);

export function SourceDatasetDetailPage({ id, onBack }: { id: string; onBack: () => void }) {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  const qc = useQueryClient();
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [confirmClearOverride, setConfirmClearOverride] = useState(false);

  const { data: ds, isLoading, error } = useQuery({
    queryKey: ['source-dataset', id],
    queryFn: () => apiGet<SourceDatasetData>(`/source-datasets/${id}`),
    retry: (failureCount, err) => (err as ApiError).status === 404 ? false : failureCount < 3,
    refetchInterval: (q) => {
      if (q.state.error) return false;
      const s = (q.state.data as SourceDatasetData | undefined)?.status;
      return s === 'SCANNING' ? 3000 : false;
    },
  });

  const scanId = ds?.latest_scan_id ?? null;

  const classes = useQuery({
    queryKey: ['source-dataset-classes', id, scanId],
    queryFn: () => apiGet<ClassItem[]>(`/source-datasets/${id}/scans/${scanId}/classes?size=200`),
    enabled: !!scanId,
  });

  const issues = useQuery({
    queryKey: ['source-dataset-issues', id, scanId],
    queryFn: () => apiGet<IssueItem[]>(`/source-datasets/${id}/scans/${scanId}/issues?size=100`),
    enabled: !!scanId,
  });

  const rescanMut = useMutation({
    mutationFn: () => apiSend('POST', `/source-datasets/${id}/rescan`, undefined, csrfToken),
    onSettled: () => qc.invalidateQueries({ queryKey: ['source-dataset', id] }),
  });

  const overrideMut = useMutation({
    mutationFn: (names: string[] | null) =>
      apiSend('POST', `/source-datasets/${id}/classes-override`, { class_names: names }, csrfToken),
    onSuccess: () => {
      setOverrideOpen(false);
      qc.invalidateQueries({ queryKey: ['source-dataset', id] });
      qc.invalidateQueries({ queryKey: ['source-dataset-classes', id] });
      qc.invalidateQueries({ queryKey: ['source-datasets'] });
    },
  });

  const scan = ds?.latest_scan ?? null;
  const canOverride = !!ds && OVERRIDABLE_SOURCES.has(scan?.classes_source ?? null);

  const classNameMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of classes.data ?? []) m.set(c.class_index, c.class_name);
    return m;
  }, [classes.data]);

  const overrideInitialNames = useMemo(
    () => ds?.manual_classes_override ?? classes.data?.map((c) => c.class_name) ?? [],
    [ds?.manual_classes_override, classes.data],
  );

  return (
    <section className="page">
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <button className="back-btn" onClick={onBack}>← Back</button>
        {ds && !ds.archived_at && (
          <button
            className="btn btn-sm btn-ghost"
            disabled={rescanMut.isPending || ds.status === 'SCANNING'}
            onClick={() => rescanMut.mutate()}
          >
            {ds.status === 'SCANNING' ? 'Scanning…' : 'Rescan'}
          </button>
        )}
      </div>

      {isLoading && <SkeletonLoader rows={5} cols={4} />}
      {error && (
        <EmptyState
          type="error"
          message={
            (error as ApiError).status === 404
              ? 'This source dataset no longer exists or you may not have access to it.'
              : (error as Error).message
          }
        />
      )}

      {ds && (
        <>
          <header className="page-head">
            <h2>{ds.name}</h2>
            <StatusBadge status={ds.status} />
          </header>

          <div className={ds.status === 'READY' ? 'detail-split' : undefined}>
          <div className="detail-main">

          <dl className="dl">
            <div><dt>Task type</dt><dd>{ds.task_type}</dd></div>
            <div><dt>Path</dt><dd><PathDisplay path={ds.relative_path} /></dd></div>
            <div><dt>Images dir</dt><dd><code>{ds.images_relative_path}</code></dd></div>
            <div><dt>Labels dir</dt><dd><code>{ds.labels_relative_path}</code></dd></div>
            <div><dt>Created</dt><dd>{formatDate(ds.created_at)}</dd></div>
          </dl>

          {ds.status === 'INVALID' && scan?.error_message && (
            <EmptyState type="error" message={`${scan.error_code}: ${scan.error_message}`} />
          )}

          {scan && (
            <>
              <h3 className="dash-h">Scan #{scan.scan_version}</h3>
              <dl className="dl">
                <div><dt>Images</dt><dd>{scan.image_count}</dd></div>
                <div><dt>Labels</dt><dd>{scan.label_count}</dd></div>
                <div><dt>Matched pairs</dt><dd>{scan.matched_pair_count}</dd></div>
                <div><dt>Missing images</dt><dd>{scan.missing_image_count}</dd></div>
                <div><dt>Missing labels</dt><dd>{scan.missing_label_count}</dd></div>
                <div><dt>Invalid labels</dt><dd>{scan.invalid_label_count}</dd></div>
                <div><dt>Empty labels</dt><dd>{scan.empty_label_count}</dd></div>
                <div><dt>Warnings</dt><dd>{scan.warning_count}</dd></div>
                <div><dt>Errors</dt><dd>{scan.error_count}</dd></div>
                <div><dt>Finished</dt><dd>{formatDate(scan.finished_at)}</dd></div>
              </dl>
            </>
          )}

          <h3 className="dash-h">
            Classes ({scan?.class_count ?? 0})
            {scan?.classes_source && <span className="hint" style={{ marginLeft: '0.5rem' }}>source: {scan.classes_source}</span>}
          </h3>
          {scan?.classes_source === 'TYPE_FALLBACK' && (
            <p className="hint folder-sub-warn">
              ⚠ No classes.txt in this folder — using the majority classes.txt among other datasets of this type.
            </p>
          )}
          {ds.classes_file_relative_path && (
            <p className="hint">
              classes.txt on disk at <code>{ds.classes_file_relative_path}</code>
              {ds.manual_classes_override ? ' — manual override replaces it.' : ' — can be overridden with a manual class list.'}
            </p>
          )}

          {canOverride && (
            <div className="override-actions">
              <button className="btn btn-sm" onClick={() => setOverrideOpen(true)}>
                {ds.manual_classes_override ? 'Edit manual class list' : 'Enter class list manually'}
              </button>
              {ds.manual_classes_override && (
                <button
                  className="btn btn-sm btn-danger"
                  disabled={overrideMut.isPending}
                  onClick={() => setConfirmClearOverride(true)}
                >
                  Clear override
                </button>
              )}
            </div>
          )}

          {classes.data && classes.data.length > 0 && (
            <details className="collapse" open={classes.data.length <= CLASS_COLLAPSE_THRESHOLD}>
              <summary className="dash-h collapse-summary">Class list</summary>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Index</th><th>Name</th><th>Objects</th></tr>
                  </thead>
                  <tbody>
                    {classes.data.map((c) => (
                      <tr key={c.class_index}>
                        <td>{c.class_index}</td>
                        <td>{c.class_name}</td>
                        <td>{c.object_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}

          {issues.data && issues.data.length > 0 && (
            <>
              <h3 className="dash-h">Scan Issues ({issues.data.length})</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Severity</th><th>Code</th><th>Image</th><th>Label</th><th>Line</th></tr>
                  </thead>
                  <tbody>
                    {issues.data.map((iss) => (
                      <tr key={iss.id}>
                        <td>{iss.severity}</td>
                        <td>{iss.issue_code}</td>
                        <td>{iss.image_relative_path ?? '—'}</td>
                        <td>{iss.label_relative_path ?? '—'}</td>
                        <td>{iss.line_number ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          </div>

          {ds.status === 'READY' && (
            <div className="detail-side">
              <h3 className="dash-h">Preview</h3>
              <DatasetPreviewPanel datasetId={id} kind="source" classNames={classNameMap} />
            </div>
          )}
          </div>

          {overrideOpen && (
            <ClassesOverrideModal
              initialNames={overrideInitialNames}
              isPending={overrideMut.isPending}
              serverError={overrideMut.error ? (overrideMut.error as Error).message : null}
              onSave={(names) => overrideMut.mutate(names)}
              onClose={() => setOverrideOpen(false)}
            />
          )}
        </>
      )}
      {confirmClearOverride && (
        <ConfirmDialog
          title="Clear Override"
          message="Clear the manual override and fall back to automatic detection?"
          confirmLabel="Clear"
          danger
          onCancel={() => setConfirmClearOverride(false)}
          onConfirm={() => { setConfirmClearOverride(false); overrideMut.mutate(null); }}
        />
      )}
    </section>
  );
}

/**
 * Admin-edited class list for a source dataset. A floating window rather than an
 * inline form: the list can run to dozens of entries and the page already carries
 * the classes table + issues below it. Accepts a classes.txt upload or direct typing
 * — both validated client-side (non-empty, unique) before the backend re-checks and
 * reconciles against every label file on disk.
 */
function ClassesOverrideModal({
  initialNames, isPending, serverError, onSave, onClose,
}: {
  initialNames: string[];
  isPending: boolean;
  serverError: string | null;
  onSave: (names: string[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initialNames.join('\n'));
  const fileRef = useRef<HTMLInputElement>(null);
  const gutterRef = useRef<HTMLPreElement>(null);
  const parsed = useMemo(() => parseClassList(draft), [draft]);
  const valid = parsed.names.length > 0 && parsed.errors.length === 0;

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setDraft(await file.text());
    if (fileRef.current) fileRef.current.value = '';
  };

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Edit class list</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          <p className="hint">
            One class name per line. The line number is the class id (starting at 0) used in
            label files — the column on the left. Stored as metadata only — never written to
            the source folder. Saving checks every label file against the list, then triggers
            a rescan.
          </p>
          <div className="override-actions" style={{ marginBottom: '0.5rem' }}>
            <input ref={fileRef} type="file" accept=".txt" hidden onChange={onFile} />
            <button className="btn btn-sm btn-ghost" onClick={() => fileRef.current?.click()}>
              Upload classes.txt
            </button>
            <span className="hint">{parsed.names.length} classes</span>
          </div>
          <div className="override-editor">
            <pre className="override-gutter" ref={gutterRef} aria-hidden>
              {draft.split(/\r?\n/).map((_, i) => i).join('\n')}
            </pre>
            <textarea
              className="override-textarea"
              name="class-list"
              rows={12}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onScroll={(e) => { if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop; }}
              spellCheck={false}
            />
          </div>
          {parsed.errors.length > 0 && (
            <div className="form-error">
              {parsed.errors.map((m) => <div key={m}>{m}</div>)}
            </div>
          )}
          {serverError && <div className="form-error">{serverError}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn btn-sm btn-ghost" onClick={onClose} disabled={isPending}>Cancel</button>
          <button
            className="btn btn-sm btn-primary"
            disabled={!valid || isPending}
            onClick={() => onSave(parsed.names)}
          >
            {isPending ? 'Checking labels…' : 'Save & rescan'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** One class name per line; blank lines and duplicates are format violations. */
function parseClassList(text: string): { names: string[]; errors: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const names: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  lines.forEach((name, i) => {
    if (!name) { errors.push(`Line ${i + 1} is empty`); return; }
    if (seen.has(name)) { errors.push(`Line ${i + 1} duplicates “${name}”`); return; }
    seen.add(name);
    names.push(name);
  });
  return { names, errors };
}
