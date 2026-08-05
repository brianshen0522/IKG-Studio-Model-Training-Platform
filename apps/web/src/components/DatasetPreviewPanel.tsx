import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';

interface SamplesResult {
  files: string[];
  total: number;
}

interface LabelBox {
  class_index: number;
  values: number[];
}

interface LabelsResult {
  task_type: string;
  boxes: LabelBox[];
}

const PAGE_SIZE = 24;

function classColor(index: number): string {
  const hue = (index * 47) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

function drawOverlay(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  labels: LabelsResult,
  classNames: Map<number, string>,
  withLabels: boolean,
) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(img, 0, 0, w, h);
  ctx.lineWidth = Math.max(withLabels ? 2 : 3, Math.round(w / (withLabels ? 400 : 120)));
  ctx.font = `${Math.max(14, Math.round(w / 60))}px sans-serif`;
  ctx.textBaseline = 'top';

  for (const box of labels.boxes) {
    const color = classColor(box.class_index);
    const name = `${classNames.get(box.class_index) ?? `class_${box.class_index}`} (${box.class_index})`;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;

    let labelX: number;
    let labelY: number;
    if (labels.task_type === 'OBB' && box.values.length === 8) {
      const pts = box.values;
      ctx.beginPath();
      ctx.moveTo(pts[0] * w, pts[1] * h);
      for (let i = 2; i < 8; i += 2) ctx.lineTo(pts[i] * w, pts[i + 1] * h);
      ctx.closePath();
      ctx.stroke();
      labelX = Math.min(pts[0], pts[2], pts[4], pts[6]) * w;
      labelY = Math.min(pts[1], pts[3], pts[5], pts[7]) * h;
    } else if (box.values.length === 4) {
      const [cx, cy, bw, bh] = box.values;
      const x = (cx - bw / 2) * w;
      const y = (cy - bh / 2) * h;
      ctx.strokeRect(x, y, bw * w, bh * h);
      labelX = x;
      labelY = y;
    } else {
      continue;
    }

    if (!withLabels) continue;
    const textW = ctx.measureText(name).width + 6;
    const textH = Math.max(16, Math.round(w / 60) + 4);
    ctx.fillRect(labelX, Math.max(0, labelY - textH), textW, textH);
    ctx.fillStyle = '#fff';
    ctx.fillText(name, labelX + 3, Math.max(0, labelY - textH) + 2);
  }
}

// Training datasets are split into train/val/test and served under
// `/samples/{split}/{filename}/...`. Source datasets are flat (single images+labels
// dir, optionally with subdirs) and served under `/samples/{filename}/...`. `kind`
// picks the URL shape; `split` is null for source datasets.
interface PreviewKind {
  kind: 'training' | 'source';
  datasetId: string;
  split: 'train' | 'val' | 'test';
}

function samplePathPrefix(k: PreviewKind): string {
  const base = k.kind === 'training'
    ? `/training-datasets/${k.datasetId}`
    : `/source-datasets/${k.datasetId}`;
  return k.kind === 'training' ? `${base}/samples/${k.split}` : `${base}/samples`;
}

// apiGet() prepends `/api/v1`; a raw <img> src must carry it itself.
function sampleImageUrl(k: PreviewKind, filename: string): string {
  return `/api/v1${samplePathPrefix(k)}/${encodeURIComponent(filename)}/image`;
}

function SampleModal({
  kind, files, index, classNames, onNavigate, onClose,
}: {
  kind: PreviewKind; files: string[]; index: number;
  classNames: Map<number, string>;
  onNavigate: (next: number) => void; onClose: () => void;
}) {
  const filename = files[index];
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labels = useQuery({
    queryKey: ['dataset-sample-labels', kind, filename],
    queryFn: () => apiGet<LabelsResult>(
      `${samplePathPrefix(kind)}/${encodeURIComponent(filename)}/labels`,
    ),
  });

  useEffect(() => {
    if (!labels.data || !canvasRef.current) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled && canvasRef.current) drawOverlay(canvasRef.current, img, labels.data!, classNames, true);
    };
    img.src = sampleImageUrl(kind, filename);
    return () => { cancelled = true; };
  }, [labels.data, kind, filename, classNames]);

  const step = (dir: 1 | -1) => () => onNavigate((index + dir + files.length) % files.length);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key;
      if (k === 'Escape') onClose();
      else if (k === 'ArrowLeft' || k === 'a' || k === 'A') onNavigate((index - 1 + files.length) % files.length);
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') onNavigate((index + 1) % files.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onNavigate, index, files.length]);

  // Portal to <body>: this modal opens from inside .detail-side, a `position: sticky`
  // element that forms its own stacking context. Without a portal, the modal's z-index
  // only wins locally — sibling sticky <th> elements outside .detail-side (z-index: 1)
  // still render on top of the whole subtree, including this modal.
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card-wide preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <button className="btn btn-sm btn-ghost" onClick={step(-1)} title="Previous (a / ←)">← Prev</button>
          <span>{filename} ({index + 1}/{files.length})</span>
          <button className="btn btn-sm btn-ghost" onClick={step(1)} title="Next (d / →)">Next →</button>
          <button className="btn btn-sm btn-ghost" onClick={onClose}>Close</button>
        </div>
        {labels.isLoading && <p className="hint">Loading…</p>}
        <canvas ref={canvasRef} className="preview-canvas" />
        {labels.data && (
          <p className="hint">
            {labels.data.boxes.length} object{labels.data.boxes.length === 1 ? '' : 's'} · {labels.data.task_type}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}

function PreviewThumb({
  kind, filename, classNames, onClick,
}: {
  kind: PreviewKind; filename: string;
  classNames: Map<number, string>; onClick: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labels = useQuery({
    queryKey: ['dataset-sample-labels', kind, filename],
    queryFn: () => apiGet<LabelsResult>(
      `${samplePathPrefix(kind)}/${encodeURIComponent(filename)}/labels`,
    ),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!labels.data || !canvasRef.current) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled && canvasRef.current) drawOverlay(canvasRef.current, img, labels.data!, classNames, false);
    };
    img.src = sampleImageUrl(kind, filename);
    return () => { cancelled = true; };
  }, [labels.data, kind, filename, classNames]);

  return (
    <button className="preview-thumb" onClick={onClick} title={filename}>
      <canvas ref={canvasRef} />
    </button>
  );
}

export function DatasetPreviewPanel({
  datasetId, kind = 'training', classNames,
}: {
  datasetId: string;
  kind?: 'training' | 'source';
  classNames: Map<number, string>;
}) {
  const [split, setSplit] = useState<'train' | 'val' | 'test'>('train');
  const [offset, setOffset] = useState(0);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  const previewKind: PreviewKind = { kind, datasetId, split };

  const samples = useQuery({
    queryKey: ['dataset-samples', kind, datasetId, split, offset],
    queryFn: () => apiGet<SamplesResult>(
      kind === 'training'
        ? `/training-datasets/${datasetId}/samples?split=${split}&limit=${PAGE_SIZE}&offset=${offset}`
        : `/source-datasets/${datasetId}/samples?limit=${PAGE_SIZE}&offset=${offset}`,
    ),
  });

  const switchSplit = (s: 'train' | 'val' | 'test') => {
    setSplit(s);
    setOffset(0);
  };

  return (
    <div className="preview-panel">
      {kind === 'training' && (
        <div className="preview-tabs">
          {(['train', 'val', 'test'] as const).map((s) => (
            <button
              key={s}
              className={`subnav-btn ${split === s ? 'active' : ''}`}
              onClick={() => switchSplit(s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {samples.isLoading && <p className="hint">Loading samples…</p>}
      {samples.data && samples.data.total === 0 && (
        <p className="hint">{kind === 'training' ? 'No images in this split.' : 'No images found.'}</p>
      )}

      {samples.data && samples.data.files.length > 0 && (
        <>
          <div className="preview-grid">
            {samples.data.files.map((f, i) => (
              <PreviewThumb
                key={f}
                kind={previewKind}
                filename={f}
                classNames={classNames}
                onClick={() => setSelectedIdx(i)}
              />
            ))}
          </div>
          <div className="preview-pager">
            <button
              className="btn btn-sm btn-ghost"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              ← Prev
            </button>
            <span className="hint">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, samples.data.total)} of {samples.data.total}
            </span>
            <button
              className="btn btn-sm btn-ghost"
              disabled={offset + PAGE_SIZE >= samples.data.total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next →
            </button>
          </div>
        </>
      )}

      {selectedIdx !== null && samples.data && samples.data.files.length > 0 && (
        <SampleModal
          kind={previewKind}
          files={samples.data.files}
          index={Math.min(selectedIdx, samples.data.files.length - 1)}
          classNames={classNames}
          onNavigate={(next) => setSelectedIdx(next)}
          onClose={() => setSelectedIdx(null)}
        />
      )}
    </div>
  );
}
