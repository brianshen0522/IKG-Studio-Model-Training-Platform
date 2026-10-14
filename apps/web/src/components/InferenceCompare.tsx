import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiGetList } from '../lib/api';
import { SearchableSelect, type SelectOption } from './SearchableSelect';
import { EmptyState } from './EmptyState';

/**
 * Side-by-side preview of one inference run dataset's differing images:
 * original labels on the left, the model's predictions on the right, every box
 * coloured by how the matching judged it (docs/inference-compare-plan.md §6.5).
 * Modelled on Dataset Manager's compare page: one shared zoom/pan for both
 * canvases and a thumbnail strip; what it adds is the per-box verdict.
 */

interface RunDatasetInfo {
  id: string;
  source_dataset_name: string;
  diff_image_count: number;
  source_changed: boolean;
  class_names: string[];
  run_name: string;
  conf_threshold: number;
  iou_threshold: number;
}

interface DiffListItem {
  id: string;
  image_relative_path: string;
  missing_count: number;
  extra_count: number;
  class_mismatch_count: number;
  label_invalid: boolean;
}

interface Box {
  class_index: number;
  values: number[]; // cx, cy, w, h — normalised
  conf?: number;
}

type MatchKind = 'MATCH' | 'CLASS_MISMATCH' | 'MISSING' | 'EXTRA';

interface MatchEntry {
  kind: MatchKind;
  original: number | null;
  predicted: number | null;
  iou: number | null;
}

interface DiffDetail extends DiffListItem {
  original_boxes: Box[];
  predicted_boxes: Box[];
  matches: MatchEntry[];
}

interface View {
  scale: number;
  tx: number;
  ty: number;
}

const PAGE_SIZE = 100;

// Canvas needs real colours, not CSS variables.
const KIND_COLOR: Record<MatchKind, string> = {
  MATCH: '#22c55e',
  CLASS_MISMATCH: '#f59e0b',
  MISSING: '#ef4444',
  EXTRA: '#3b82f6',
};
const KIND_LABEL: Record<MatchKind, string> = {
  MATCH: 'Same',
  CLASS_MISMATCH: 'Class differs',
  MISSING: 'Only in original',
  EXTRA: 'Only in prediction',
};

const KIND_OPTIONS: SelectOption[] = [
  { value: '', label: 'All differences' },
  { value: 'MISSING', label: 'Only in original (missing)' },
  { value: 'EXTRA', label: 'Only in prediction (extra)' },
  { value: 'CLASS_MISMATCH', label: 'Class differs' },
  { value: 'LABEL_INVALID', label: 'Unreadable original label' },
];
const SORT_OPTIONS: SelectOption[] = [
  { value: 'path', label: 'By file name' },
  { value: 'most', label: 'Most differences first' },
];

interface DrawBox {
  box: Box;
  entry: number; // index into matches
  kind: MatchKind;
  label: string;
}

/** One side of the comparison. The view is owned by the parent so both sides move together. */
function DiffCanvas({
  img, boxes, view, onView, selected, onPick, showMatched, title, subtitle,
}: {
  img: HTMLImageElement | null;
  boxes: DrawBox[];
  view: View | null;
  onView: (v: View) => void;
  selected: number | null;
  onPick: (entry: number | null) => void;
  showMatched: boolean;
  title: string;
  subtitle: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const drag = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visible = useMemo(
    () => boxes.filter((b) => showMatched || b.kind !== 'MATCH' || b.entry === selected),
    [boxes, showMatched, selected],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    if (!img || !view) return;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    ctx.imageSmoothingEnabled = view.scale < 2;
    ctx.drawImage(img, view.tx, view.ty, iw * view.scale, ih * view.scale);

    // Selected last, so it is drawn on top of anything it overlaps.
    const ordered = [...visible].sort((a, b) => Number(a.entry === selected) - Number(b.entry === selected));
    for (const b of ordered) {
      const [cx, cy, w, h] = b.box.values;
      const x = (cx - w / 2) * iw * view.scale + view.tx;
      const y = (cy - h / 2) * ih * view.scale + view.ty;
      const bw = w * iw * view.scale;
      const bh = h * ih * view.scale;
      const isSel = b.entry === selected;
      const color = KIND_COLOR[b.kind];
      ctx.lineWidth = isSel ? 3 : 2;
      ctx.strokeStyle = color;
      ctx.globalAlpha = selected === null || isSel ? 1 : 0.45;
      ctx.strokeRect(x, y, bw, bh);
      if (isSel) {
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - 3, y - 3, bw + 6, bh + 6);
        ctx.setLineDash([]);
      }
      ctx.font = '12px system-ui, sans-serif';
      const tw = ctx.measureText(b.label).width + 8;
      const ly = y - 18 < 0 ? y : y - 18;
      ctx.fillStyle = color;
      ctx.fillRect(x, ly, tw, 18);
      ctx.fillStyle = '#0b1220';
      ctx.fillText(b.label, x + 4, ly + 13);
    }
    ctx.globalAlpha = 1;
  }, [img, view, visible, selected, size]);

  const toImage = (mx: number, my: number) => {
    if (!img || !view) return null;
    return {
      x: (mx - view.tx) / (img.naturalWidth * view.scale),
      y: (my - view.ty) / (img.naturalHeight * view.scale),
    };
  };

  const pick = (mx: number, my: number) => {
    const p = toImage(mx, my);
    if (!p) return;
    // Smallest box under the cursor, so a box inside a bigger one stays clickable.
    let best: DrawBox | null = null;
    for (const b of visible) {
      const [cx, cy, w, h] = b.box.values;
      if (Math.abs(p.x - cx) <= w / 2 && Math.abs(p.y - cy) <= h / 2) {
        if (!best || w * h < best.box.values[2] * best.box.values[3]) best = b;
      }
    }
    onPick(best ? best.entry : null);
  };

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // Non-passive, so the page does not scroll while zooming.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      if (!view) return;
      e.preventDefault();
      const { x, y } = local(e);
      const factor = Math.exp(-e.deltaY * 0.0015);
      const scale = Math.min(Math.max(view.scale * factor, 0.05), 40);
      const k = scale / view.scale;
      onView({ scale, tx: x - (x - view.tx) * k, ty: y - (y - view.ty) * k });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [view, onView]);

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <strong style={{ fontSize: 13 }}>{title}</strong>
        <span style={{ fontSize: 12, color: 'var(--text-sub)' }}>{subtitle}</span>
      </div>
      <div
        ref={wrapRef}
        style={{
          flex: 1, minHeight: 360, height: '58vh', background: '#05080f', borderRadius: 'var(--radius)',
          border: '1px solid var(--border)', overflow: 'hidden', position: 'relative',
        }}
      >
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: '100%', display: 'block', cursor: drag.current ? 'grabbing' : 'crosshair' }}
          onMouseDown={(e) => {
            if (!view) return;
            const p = local(e);
            drag.current = { x: p.x, y: p.y, view, moved: false };
          }}
          onMouseMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const p = local(e);
            const dx = p.x - d.x;
            const dy = p.y - d.y;
            if (!d.moved && Math.hypot(dx, dy) < 3) return;
            d.moved = true;
            onView({ ...d.view, tx: d.view.tx + dx, ty: d.view.ty + dy });
          }}
          onMouseUp={(e) => {
            const d = drag.current;
            drag.current = null;
            if (d && !d.moved) {
              const p = local(e);
              pick(p.x, p.y);
            }
          }}
          onMouseLeave={() => { drag.current = null; }}
          onDoubleClick={() => onView({ scale: -1, tx: 0, ty: 0 })}
        />
        {!img && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--text-sub)', fontSize: 13 }}>
            Loading image…
          </div>
        )}
      </div>
    </div>
  );
}

export function InferenceCompare({ runId, rdId, onBack }: { runId: string; rdId: string; onBack: () => void }) {
  const [kind, setKind] = useState('');
  const [sort, setSort] = useState('path');
  const [page, setPage] = useState(1);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [showMatched, setShowMatched] = useState(true);
  const [view, setView] = useState<View | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [imgError, setImgError] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  // After stepping back across a page boundary, land on that page's last image.
  const landOnLast = useRef(false);

  const base = `/inference-runs/${runId}/datasets/${rdId}`;
  const { data: info } = useQuery({
    queryKey: ['inference-rd', runId, rdId],
    queryFn: () => apiGet<RunDatasetInfo>(base),
  });
  const { data: list, isLoading: listLoading, error: listError } = useQuery({
    queryKey: ['inference-diffs', runId, rdId, kind, sort, page],
    queryFn: () => apiGetList<DiffListItem>(`${base}/diffs?page=${page}&size=${PAGE_SIZE}&sort=${sort}${kind ? `&kind=${kind}` : ''}`),
    placeholderData: (prev) => prev,
  });
  const items = list?.data ?? [];
  const total = list?.meta.total ?? 0;
  const current = items[Math.min(index, items.length - 1)] ?? null;

  useEffect(() => {
    if (!list) return;
    if (landOnLast.current) {
      landOnLast.current = false;
      setIndex(Math.max(list.data.length - 1, 0));
    }
  }, [list]);

  const { data: detail } = useQuery({
    queryKey: ['inference-diff', runId, rdId, current?.id],
    enabled: !!current,
    queryFn: () => apiGet<DiffDetail>(`${base}/diffs/${current!.id}`),
  });

  // Load the image for the current diff; the view is refit when it arrives.
  useEffect(() => {
    setSelected(null);
    setImgError(null);
    if (!current) { setImg(null); return; }
    let cancelled = false;
    const el = new Image();
    el.onload = () => { if (!cancelled) { setImg(el); setView(null); } };
    el.onerror = () => { if (!cancelled) { setImg(null); setImgError('The source image could not be loaded — it may have been moved or deleted since the run.'); } };
    el.src = `/api/v1${base}/diffs/${current.id}/image`;
    return () => { cancelled = true; };
  }, [current?.id, base]);

  const fit = useCallback((): View | null => {
    const stage = stageRef.current;
    if (!img || !stage) return null;
    // Both canvases are the same size: half the stage, less the gap.
    const cw = (stage.clientWidth - 12) / 2;
    const canvasEl = stage.querySelector('canvas');
    const ch = canvasEl ? canvasEl.clientHeight : 400;
    const scale = Math.min(cw / img.naturalWidth, ch / img.naturalHeight);
    return { scale, tx: (cw - img.naturalWidth * scale) / 2, ty: (ch - img.naturalHeight * scale) / 2 };
  }, [img]);

  useEffect(() => { if (img && !view) setView(fit()); }, [img, view, fit]);
  const onView = useCallback((v: View) => setView(v.scale < 0 ? fit() : v), [fit]);

  const go = useCallback((delta: number) => {
    const next = index + delta;
    if (next >= 0 && next < items.length) { setIndex(next); return; }
    if (delta > 0 && page * PAGE_SIZE < total) { setPage(page + 1); setIndex(0); }
    if (delta < 0 && page > 1) { landOnLast.current = true; setPage(page - 1); }
  }, [index, items.length, page, total]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  const className = useCallback((i: number) => info?.class_names[i] ?? `#${i}`, [info]);

  const { originalBoxes, predictedBoxes } = useMemo(() => {
    const o: DrawBox[] = [];
    const p: DrawBox[] = [];
    (detail?.matches ?? []).forEach((m, i) => {
      if (m.original !== null) {
        const box = detail!.original_boxes[m.original];
        if (box) o.push({ box, entry: i, kind: m.kind, label: className(box.class_index) });
      }
      if (m.predicted !== null) {
        const box = detail!.predicted_boxes[m.predicted];
        if (box) p.push({ box, entry: i, kind: m.kind, label: `${className(box.class_index)} ${box.conf?.toFixed(2) ?? ''}`.trim() });
      }
    });
    return { originalBoxes: o, predictedBoxes: p };
  }, [detail, className]);

  const resetFilters = (next: () => void) => { next(); setPage(1); setIndex(0); };
  const position = (page - 1) * PAGE_SIZE + Math.min(index, Math.max(items.length - 1, 0)) + 1;

  return (
    <section className="page" style={{ maxWidth: 'none' }}>
      <button className="back-btn" onClick={onBack} style={{ marginBottom: '12px', cursor: 'pointer' }}>
        ← Back to run
      </button>

      <header className="page-head" style={{ marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Compare: {info?.source_dataset_name ?? '…'}</h2>
          <p style={{ margin: '4px 0 0 0', color: 'var(--text-sub)', fontSize: 13 }}>
            {info ? `${info.run_name} · conf ≥ ${info.conf_threshold} · IoU ${info.iou_threshold}` : ''}
          </p>
        </div>
        <div className="spacer" />
        <SearchableSelect label="Show" options={KIND_OPTIONS} value={kind} onChange={(v) => resetFilters(() => setKind(v))} placeholder="All differences" style={{ minWidth: 220 }} />
        <SearchableSelect label="Order" options={SORT_OPTIONS} value={sort} onChange={(v) => resetFilters(() => setSort(v))} placeholder="By file name" style={{ minWidth: 190 }} />
      </header>

      {info?.source_changed && (
        <div className="warn-banner" style={{ marginBottom: 12 }}>
          The source dataset was rescanned after this run was created. Boxes are shown as they were compared, but the
          images on disk may since have changed.
        </div>
      )}

      {listError && <EmptyState type="error" message={(listError as Error).message} />}
      {!listLoading && !listError && total === 0 && (
        <EmptyState message={kind ? 'No images with this kind of difference.' : 'No differing images in this dataset.'} />
      )}

      {current && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-sm btn-secondary" onClick={() => go(-1)} disabled={position <= 1}>◀ Prev</button>
            <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
              {position.toLocaleString()} / {total.toLocaleString()}
            </span>
            <button className="btn btn-sm btn-secondary" onClick={() => go(1)} disabled={position >= total}>Next ▶</button>
            <code style={{ fontSize: 12, color: 'var(--text-sub)', overflowWrap: 'anywhere' }}>{current.image_relative_path}</code>
            <div className="spacer" />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-sub)' }}>
              <input type="checkbox" checked={showMatched} onChange={(e) => setShowMatched(e.target.checked)} />
              Show matching boxes
            </label>
            <div style={{ display: 'flex', gap: 10, fontSize: 12 }}>
              {(Object.keys(KIND_COLOR) as MatchKind[]).map((k) => (
                <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: KIND_COLOR[k], display: 'inline-block' }} />
                  {KIND_LABEL[k]}
                </span>
              ))}
            </div>
          </div>

          {detail?.label_invalid && (
            <div className="warn-banner" style={{ marginBottom: 8 }}>
              Some lines of the original label file could not be read and are not shown.
            </div>
          )}
          {imgError && <div className="error-banner" style={{ marginBottom: 8 }}>{imgError}</div>}

          <div ref={stageRef} style={{ display: 'flex', gap: 12 }}>
            <DiffCanvas
              img={img} boxes={originalBoxes} view={view} onView={onView} selected={selected} onPick={setSelected}
              showMatched={showMatched} title="Original labels" subtitle={`${detail?.original_boxes.length ?? 0} boxes`}
            />
            <DiffCanvas
              img={img} boxes={predictedBoxes} view={view} onView={onView} selected={selected} onPick={setSelected}
              showMatched={showMatched} title="Model prediction" subtitle={`${detail?.predicted_boxes.length ?? 0} boxes`}
            />
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-sub)', margin: '6px 0 12px' }}>
            Scroll to zoom · drag to pan · double-click to fit · click a box to pair it with its counterpart · ← → to move between images
          </div>

          <div className="table-wrap" style={{ marginBottom: 14, maxHeight: 220, overflowY: 'auto' }}>
            <table style={{ fontSize: 12, margin: 0 }}>
              <thead>
                <tr><th>Verdict</th><th>Original class</th><th>Predicted class</th><th style={{ textAlign: 'right' }}>Confidence</th><th style={{ textAlign: 'right' }}>IoU</th></tr>
              </thead>
              <tbody>
                {(detail?.matches ?? [])
                  .map((m, i) => ({ m, i }))
                  .filter(({ m, i }) => showMatched || m.kind !== 'MATCH' || i === selected)
                  .map(({ m, i }) => {
                    const o = m.original !== null ? detail!.original_boxes[m.original] : null;
                    const p = m.predicted !== null ? detail!.predicted_boxes[m.predicted] : null;
                    return (
                      <tr
                        key={i}
                        onClick={() => setSelected(i === selected ? null : i)}
                        style={{ cursor: 'pointer', background: i === selected ? 'var(--surface-muted)' : undefined }}
                      >
                        <td>
                          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: KIND_COLOR[m.kind], marginRight: 6 }} />
                          {KIND_LABEL[m.kind]}
                        </td>
                        <td>{o ? className(o.class_index) : '—'}</td>
                        <td>{p ? className(p.class_index) : '—'}</td>
                        <td style={{ textAlign: 'right' }}>{p?.conf != null ? p.conf.toFixed(2) : '—'}</td>
                        <td style={{ textAlign: 'right' }}>{m.iou != null ? m.iou.toFixed(2) : '—'}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 6 }}>
            {items.map((it, i) => {
              const active = i === index;
              return (
                <button
                  key={it.id}
                  onClick={() => setIndex(i)}
                  title={it.image_relative_path}
                  style={{
                    flex: '0 0 auto', width: 112, padding: 0, background: 'var(--surface)', cursor: 'pointer',
                    border: `2px solid ${active ? 'var(--primary)' : 'var(--border)'}`, borderRadius: 'var(--radius)', overflow: 'hidden',
                  }}
                >
                  <img
                    src={`/api/v1${base}/diffs/${it.id}/image`}
                    loading="lazy"
                    alt=""
                    style={{ width: '100%', height: 64, objectFit: 'cover', display: 'block', background: '#05080f' }}
                  />
                  <div style={{ fontSize: 10, padding: '3px 4px', display: 'flex', gap: 4, justifyContent: 'center' }}>
                    {it.missing_count > 0 && <span style={{ color: KIND_COLOR.MISSING }}>−{it.missing_count}</span>}
                    {it.extra_count > 0 && <span style={{ color: KIND_COLOR.EXTRA }}>+{it.extra_count}</span>}
                    {it.class_mismatch_count > 0 && <span style={{ color: KIND_COLOR.CLASS_MISMATCH }}>≠{it.class_mismatch_count}</span>}
                    {it.label_invalid && <span style={{ color: 'var(--red)' }}>!</span>}
                  </div>
                </button>
              );
            })}
          </div>
          {total > PAGE_SIZE && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--text-sub)', marginTop: 6 }}>
              <button className="btn btn-sm btn-secondary" disabled={page <= 1} onClick={() => { setPage(page - 1); setIndex(0); }}>Previous {PAGE_SIZE}</button>
              <span>Page {page} of {Math.ceil(total / PAGE_SIZE)}</span>
              <button className="btn btn-sm btn-secondary" disabled={page * PAGE_SIZE >= total} onClick={() => { setPage(page + 1); setIndex(0); }}>Next {PAGE_SIZE}</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
