import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';

/**
 * Artifact image thumbnails plus a full-size viewer.
 *
 * Shared by the model and training-job detail pages: the training images (charts,
 * confusion matrix, validation batches) are the same artifacts seen from two
 * directions, and they were drifting apart — one page had Escape-to-close and a
 * download link, the other did not.
 *
 * Any image artifact is previewable — not just the fixed chart types — and the
 * lightbox zooms (buttons, click, +/-/0 keys) and pans (drag) into dense images
 * like a confusion matrix, plus a/d and arrow keys to step through the batch.
 */

export interface ChartArtifact {
  id: string;
  artifact_type_code: string;
  filename: string;
}

export const CHART_LABELS: Record<string, string> = {
  RESULTS_IMAGE: 'Results',
  CONFUSION_MATRIX_NORMALIZED: 'Normalized Confusion Matrix',
  CONFUSION_MATRIX: 'Confusion Matrix',
  PR_CURVE: 'PR Curve',
  PRECISION_CURVE: 'Precision Curve',
  RECALL_CURVE: 'Recall Curve',
  F1_CURVE: 'F1 Curve',
  VALIDATION_IMAGE: 'Validation',
  BENCHMARK_METRICS: 'Metrics',
};

export const chartLabel = (a: ChartArtifact) => CHART_LABELS[a.artifact_type_code] ?? a.filename;

/** Human-readable names for every artifact type shown in the artifacts tables. */
export const ARTIFACT_LABELS: Record<string, string> = {
  ...CHART_LABELS,
  BEST_MODEL: 'Best Model',
  MODEL_FILE: 'Model File',
  TRAIN_LOG: 'Training Log',
  RESULTS_CSV: 'Results CSV',
  ARGS_YAML: 'Args YAML',
  DATA_YAML: 'Data YAML',
  BENCHMARK_METRICS: 'Benchmark Metrics',
  DATASET_MANIFEST: 'Dataset Manifest',
  ARTIFACT_MANIFEST: 'Artifact Manifest',
  IMPORT_REPORT: 'Import Report',
  TRAINING_OUTPUT: 'Training Output',
};

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.gif']);

/** True when the artifact's file is an image the browser can render inline. */
export const isImageArtifact = (a: { filename: string }) =>
  IMAGE_EXTS.has(a.filename.slice(a.filename.lastIndexOf('.')).toLowerCase());

const TEXT_EXTS = new Set(['.txt', '.csv', '.log', '.json', '.yaml', '.yml']);

/** True when the artifact is a plain-text file worth showing inline (logs, CSVs…). */
export const isTextArtifact = (a: { filename: string }) =>
  TEXT_EXTS.has(a.filename.slice(a.filename.lastIndexOf('.')).toLowerCase());

export function ChartGrid({
  artifacts,
  onOpen,
}: {
  artifacts: ChartArtifact[];
  onOpen: (index: number) => void;
}) {
  return (
    <div className="chart-grid">
      {artifacts.map((a, i) => (
        <button key={a.id} className="chart-figure" onClick={() => onOpen(i)} title={`Open ${chartLabel(a)}`}>
          <img src={`/api/v1/artifacts/${a.id}/view`} alt={chartLabel(a)} loading="lazy" />
          <span className="chart-caption">{chartLabel(a)}<span className="chart-zoom" aria-hidden>⤢</span></span>
        </button>
      ))}
    </div>
  );
}

const ZOOM_MAX = 4;

/** Dense artifacts are unreadable at thumbnail size, so this opens the original as
 *  large as the viewport allows and lets the user zoom in further for the fine print. */
export function ChartLightbox({
  artifacts,
  index,
  onNavigate,
  onClose,
}: {
  artifacts: ChartArtifact[];
  index: number;
  onNavigate: (next: number) => void;
  onClose: () => void;
}) {
  const artifact = artifacts[index];
  const label = chartLabel(artifact);
  const [zoom, setZoom] = useState<number | null>(null); // null = fit viewport
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  useEffect(() => {
    setZoom(null);
    setNatural(null);
  }, [artifact.id]);

  const prev = () => onNavigate((index - 1 + artifacts.length) % artifacts.length);
  const next = () => onNavigate((index + 1) % artifacts.length);
  const zoomIn = () => setZoom((z) => (z ?? 1) >= ZOOM_MAX ? ZOOM_MAX : (z ?? 1) + 1);
  const zoomOut = () => setZoom((z) => (z === null || z === 1 ? null : z - 1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      if (k === 'Escape') onClose();
      else if (k === 'ArrowLeft' || k === 'a' || k === 'A') prev();
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') next();
      else if (k === '+' || k === '=') zoomIn();
      else if (k === '-' || k === '_') zoomOut();
      else if (k === '0') setZoom(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const zoomed = zoom !== null && natural !== null;

  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-label={label}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox-title">{label}</span>
        {artifacts.length > 1 && (
          <>
            <button className="btn btn-sm btn-ghost" onClick={prev} title="Previous (a / ←)">←</button>
            <span className="lightbox-count">{index + 1}/{artifacts.length}</span>
            <button className="btn btn-sm btn-ghost" onClick={next} title="Next (d / →)">→</button>
          </>
        )}
        <span className="spacer" />
        <button className="btn btn-sm btn-ghost" onClick={zoomOut} disabled={!zoomed} title="Zoom out (−)">−</button>
        <button className="btn btn-sm btn-ghost" onClick={zoomIn} disabled={zoom === ZOOM_MAX} title="Zoom in (+)">+</button>
        <button className="btn btn-sm btn-ghost" onClick={() => setZoom(null)} disabled={!zoomed} title="Fit to screen (0)">Fit</button>
        <a className="btn btn-sm btn-ghost" href={`/api/v1/artifacts/${artifact.id}/download`}>Download</a>
        <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close">×</button>
      </div>

      <div
        ref={boxRef}
        className={`lightbox-canvas${zoomed ? ' is-zoomed' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          if (!zoomed) setZoom(1); // click a fitted image to start zooming
        }}
        onPointerDown={(e) => {
          if (!zoomed || !boxRef.current) return;
          dragRef.current = {
            x: e.clientX, y: e.clientY,
            left: boxRef.current.scrollLeft, top: boxRef.current.scrollTop,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = dragRef.current;
          if (!d || !boxRef.current) return;
          boxRef.current.scrollLeft = d.left - (e.clientX - d.x);
          boxRef.current.scrollTop = d.top - (e.clientY - d.y);
        }}
        onPointerUp={() => { dragRef.current = null; }}
        onPointerCancel={() => { dragRef.current = null; }}
      >
        <img
          className="lightbox-img"
          src={`/api/v1/artifacts/${artifact.id}/view`}
          alt={label}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          style={zoomed ? { width: `${natural.w * zoom}px`, maxWidth: 'none', maxHeight: 'none', height: 'auto' } : undefined}
        />
      </div>

      {artifacts.length > 1 && (
        <p className="lightbox-hint">a / ← previous · d / → next · +/− zoom · 0 fit · Esc close</p>
      )}
    </div>
  );
}

/**
 * Plain-text artifact (training log, results.csv, …) shown in a window. Fetches the
 * body through the inline `/view` endpoint — no raw MinIO access from the browser.
 * CSV becomes a real table; other text is a log with terminal escape sequences and
 * carriage-return overwrites cleaned out.
 */
export function TextArtifactModal({ artifact, onClose }: { artifact: ChartArtifact; onClose: () => void }) {
  const content = useQuery({
    queryKey: ['artifact-text', artifact.id],
    queryFn: () => fetch(`/api/v1/artifacts/${artifact.id}/view`).then((r) => r.text()),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isCsv = artifact.filename.toLowerCase().endsWith('.csv');
  const isJson = artifact.filename.toLowerCase().endsWith('.json');

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card artifact-text-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{artifact.filename}</h3>
          <a className="btn btn-sm btn-ghost" href={`/api/v1/artifacts/${artifact.id}/download`}>Download</a>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          {content.isLoading && <p className="hint">Loading…</p>}
          {content.error && <p className="form-error">Failed to load file content.</p>}
          {content.data && (
            isCsv ? <CsvTable text={content.data} />
              : <pre className="artifact-text-pre">{isJson ? prettifyJson(content.data) : sanitizeLog(content.data)}</pre>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Pretty-prints JSON the way Prettier would (2-space indent); falls back to the raw text if it doesn't parse. */
function prettifyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function CsvTable({ text }: { text: string }) {
  const rows = useMemo(() => parseCsv(text), [text]);
  if (rows.length === 0) return <p className="hint">Empty file.</p>;
  const [header, ...body] = rows;
  return (
    <div className="artifact-csv-wrap">
      <table className="artifact-csv">
        <thead>
          <tr>{header.map((h, i) => <th key={i}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>{header.map((_, j) => <td key={j}>{r[j] ?? ''}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Handles quoted fields and embedded commas/escaped quotes, like any real CSV. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.some((c) => c !== '')) rows.push(row);
  }
  return rows;
}

/**
 * YOLO logs are full of terminal noise: ANSI color codes and `\r`-overwritten
 * progress bars. Strip the escapes and turn each overwrite into its own line so the
 * file reads as plain text.
 */
function sanitizeLog(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-9A-Z]/g, '')
    .replace(/\n\r/g, '\n')
    .split(/\r/).join('\n');
}
