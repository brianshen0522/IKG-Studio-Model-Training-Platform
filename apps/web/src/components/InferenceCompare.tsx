import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiGetList } from '../lib/api';

/**
 * Side-by-side preview of one inference run dataset's differing images:
 * original labels on the left, the model's predictions on the right, every box
 * coloured by how the matching judged it (docs/inference-compare-plan.md §6.5).
 *
 * Laid out like Dataset Manager's compare page, which the people using this
 * already know: the whole window below the top bar, two canvases edge to edge
 * sharing one zoom and pan, a minimap when zoomed, labels that stay readable at
 * any zoom, and a thumbnail strip of names and marks rather than images. What
 * it adds is the per-box verdict and a summary of the current image's
 * differences, each of which selects its box pair.
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
  kind_counts: Record<FilterKey, number>;
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

/** Zoom relative to "fit", and pan in screen pixels — the same model as DM. */
interface View {
  scale: number;
  x: number;
  y: number;
}

type FilterKey = 'ALL' | 'MISSING' | 'EXTRA' | 'CLASS_MISMATCH' | 'LABEL_INVALID';
type SortKey = 'path' | 'most';

const PAGE_SIZE = 500;
const FIT = 0.95; // leave a margin round the fitted image, as DM does
const RESET: View = { scale: 1, x: 0, y: 0 };

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
const FILTERS: { key: FilterKey; label: string; hint: string }[] = [
  { key: 'ALL', label: 'All', hint: 'Every image that differs' },
  { key: 'MISSING', label: 'Missing', hint: 'A box in the original labels with no prediction over it' },
  { key: 'EXTRA', label: 'Extra', hint: 'A predicted box with nothing in the original labels under it' },
  { key: 'CLASS_MISMATCH', label: 'Class', hint: 'A box in the same place with a different class' },
  { key: 'LABEL_INVALID', label: 'Unreadable', hint: 'The original label file has lines that could not be read' },
];

const C = {
  bg: '#0d1a2e',
  panel: '#152033',
  well: '#0d1626',
  line: '#25344d',
  text: '#e6edf7',
  sub: '#9ba9c3',
  dim: '#6b7a94',
  accent: '#3b82f6',
};

interface DrawBox {
  box: Box;
  entry: number; // index into matches
  kind: MatchKind;
  label: string;
}

function placement(img: HTMLImageElement, cw: number, ch: number, view: View) {
  const base = Math.min(cw / img.naturalWidth, ch / img.naturalHeight) * FIT;
  const s = base * view.scale;
  return {
    s,
    dx: (cw - img.naturalWidth * s) / 2 + view.x,
    dy: (ch - img.naturalHeight * s) / 2 + view.y,
  };
}

/** One side. The view is the parent's, so both sides move together. */
function DiffCanvas({
  img, imgError, boxes, view, setView, selected, onPick, showBoxes, showMatched, title, badges,
}: {
  img: HTMLImageElement | null;
  imgError: string | null;
  boxes: DrawBox[];
  view: View;
  setView: (v: View) => void;
  selected: number | null;
  onPick: (entry: number | null) => void;
  showBoxes: boolean;
  showMatched: boolean;
  title: string;
  badges: { text: string; color: string }[];
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const drag = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visible = useMemo(
    () => (showBoxes ? boxes.filter((b) => showMatched || b.kind !== 'MATCH' || b.entry === selected) : []),
    [boxes, showBoxes, showMatched, selected],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0 || size.h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#050b14';
    ctx.fillRect(0, 0, size.w, size.h);
    if (!img) {
      ctx.fillStyle = C.sub;
      ctx.font = '14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(imgError ?? 'Loading image…', size.w / 2, size.h / 2);
      return;
    }
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const { s, dx, dy } = placement(img, size.w, size.h, view);
    ctx.imageSmoothingEnabled = s < 2;
    ctx.drawImage(img, dx, dy, iw * s, ih * s);

    // Selected last, so it sits on top of whatever it overlaps.
    const ordered = [...visible].sort((a, b) => Number(a.entry === selected) - Number(b.entry === selected));
    const labelH = 18;
    ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const b of ordered) {
      const [cx, cy, w, h] = b.box.values;
      const x = dx + (cx - w / 2) * iw * s;
      const y = dy + (cy - h / 2) * ih * s;
      const bw = w * iw * s;
      const bh = h * ih * s;
      const isSel = b.entry === selected;
      const color = KIND_COLOR[b.kind];
      ctx.globalAlpha = selected === null || isSel ? 1 : 0.35;
      if (isSel) {
        ctx.lineWidth = 6;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.strokeRect(x, y, bw, bh);
      }
      ctx.lineWidth = isSel ? 3 : 2;
      ctx.strokeStyle = color;
      ctx.strokeRect(x, y, bw, bh);

      // Above the box if it fits, else below, else just inside — kept within
      // the canvas either way (DM's getOverlayLabelPosition).
      const tw = ctx.measureText(b.label).width + 10;
      let ly = y - labelH - 2;
      if (ly < 0) ly = y + bh + 2 + labelH <= size.h ? y + bh + 2 : Math.max(0, y + 2);
      const lx = Math.min(Math.max(x, 0), Math.max(0, size.w - tw));
      ctx.fillStyle = color;
      ctx.globalAlpha = (selected === null || isSel ? 1 : 0.35) * 0.92;
      ctx.fillRect(lx, ly, tw, labelH);
      ctx.globalAlpha = selected === null || isSel ? 1 : 0.35;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(b.label, lx + 5, ly + labelH / 2 + 1);
    }
    ctx.globalAlpha = 1;
  }, [img, imgError, view, visible, selected, size]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const pick = (mx: number, my: number) => {
    if (!img) return;
    const { s, dx, dy } = placement(img, size.w, size.h, view);
    const px = (mx - dx) / (img.naturalWidth * s);
    const py = (my - dy) / (img.naturalHeight * s);
    // The smallest box under the cursor, so one inside a bigger one can be picked.
    let best: DrawBox | null = null;
    for (const b of visible) {
      const [cx, cy, w, h] = b.box.values;
      if (Math.abs(px - cx) <= w / 2 && Math.abs(py - cy) <= h / 2) {
        if (!best || w * h < best.box.values[2] * best.box.values[3]) best = b;
      }
    }
    onPick(best ? best.entry : null);
  };

  // Non-passive, so the page does not scroll while zooming. Zooms about the
  // cursor: the image point under it stays put.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      if (!img) return;
      e.preventDefault();
      const { x: mx, y: my } = local(e);
      const scale = Math.min(Math.max(view.scale * Math.exp(-e.deltaY * 0.0015), 1), 40);
      const before = placement(img, size.w, size.h, view);
      const ix = (mx - before.dx) / before.s;
      const iy = (my - before.dy) / before.s;
      const base = before.s / view.scale;
      const s2 = base * scale;
      const x = mx - ix * s2 - (size.w - img.naturalWidth * s2) / 2;
      const y = my - iy * s2 - (size.h - img.naturalHeight * s2) / 2;
      setView(scale === 1 ? RESET : { scale, x, y });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [img, view, size, setView]);

  // Minimap: where the visible area sits in the whole image, once zoomed in.
  let mini: { w: number; h: number; vx: number; vy: number; vw: number; vh: number } | null = null;
  if (img && view.scale > 1.05 && size.w > 0) {
    const { s, dx, dy } = placement(img, size.w, size.h, view);
    const mw = 160;
    const mh = (mw * img.naturalHeight) / img.naturalWidth;
    const k = mw / img.naturalWidth;
    const x0 = Math.max(0, -dx / s);
    const y0 = Math.max(0, -dy / s);
    const x1 = Math.min(img.naturalWidth, (size.w - dx) / s);
    const y1 = Math.min(img.naturalHeight, (size.h - dy) / s);
    mini = { w: mw, h: mh, vx: x0 * k, vy: y0 * k, vw: Math.max(0, x1 - x0) * k, vh: Math.max(0, y1 - y0) * k };
  }

  return (
    <div ref={wrapRef} style={{ flex: 1, minWidth: 0, position: 'relative', background: '#050b14' }}>
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', cursor: dragging ? 'grabbing' : 'grab' }}
        onMouseDown={(e) => {
          const p = local(e);
          drag.current = { x: p.x, y: p.y, view, moved: false };
        }}
        onMouseMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const p = local(e);
          const dx = p.x - d.x;
          const dy = p.y - d.y;
          if (!d.moved && Math.hypot(dx, dy) < 4) return;
          if (!d.moved) setDragging(true);
          d.moved = true;
          setView({ ...d.view, x: d.view.x + dx, y: d.view.y + dy });
        }}
        onMouseUp={(e) => {
          const d = drag.current;
          drag.current = null;
          setDragging(false);
          if (d && !d.moved) {
            const p = local(e);
            pick(p.x, p.y);
          }
        }}
        onMouseLeave={() => { drag.current = null; setDragging(false); }}
        onDoubleClick={() => setView(RESET)}
      />
      <div
        style={{
          position: 'absolute', top: 10, left: 12, right: 12, display: 'flex', justifyContent: 'space-between',
          alignItems: 'center', pointerEvents: 'none', textShadow: '0 2px 4px rgba(0,0,0,0.9)', gap: 8,
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 800, color: C.text }}>{title}</span>
        <span style={{ display: 'flex', gap: 6 }}>
          {badges.map((b) => (
            <span key={b.text} style={{ background: b.color, color: '#fff', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700, textShadow: 'none' }}>
              {b.text}
            </span>
          ))}
        </span>
      </div>
      {mini && img && (
        <div
          style={{
            position: 'absolute', top: 40, left: 12, width: mini.w, height: mini.h, pointerEvents: 'none',
            border: '1px solid rgba(59,130,246,0.5)', background: 'rgba(0,0,0,0.6)', borderRadius: 2, overflow: 'hidden',
          }}
        >
          <img src={img.src} alt="" style={{ width: '100%', height: '100%', opacity: 0.45, display: 'block' }} />
          <div
            style={{
              position: 'absolute', left: mini.vx, top: mini.vy, width: mini.vw, height: mini.vh,
              border: '1px solid #3b82f6', background: 'rgba(59,130,246,0.15)',
            }}
          />
        </div>
      )}
    </div>
  );
}

function Segmented<K extends string>({
  options, value, onChange,
}: {
  options: { key: K; label: string; hint?: string; count?: number }[];
  value: K;
  onChange: (k: K) => void;
}) {
  return (
    <div role="radiogroup" style={{ display: 'inline-flex', padding: 3, gap: 2, background: C.well, border: `1px solid ${C.line}`, borderRadius: 8 }}>
      {options.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.hint}
            onClick={() => onChange(o.key)}
            style={{
              background: active ? C.accent : 'transparent', color: active ? '#fff' : C.sub, border: 'none',
              borderRadius: 6, padding: '5px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            {o.label}
            {o.count !== undefined && <span style={{ opacity: 0.75, fontWeight: 600, marginLeft: 4 }}>{o.count.toLocaleString()}</span>}
          </button>
        );
      })}
    </div>
  );
}

const toolBtn = (active = false): React.CSSProperties => ({
  background: active ? C.accent : C.line, border: 'none', color: active ? '#fff' : C.text, padding: '6px 12px',
  borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
});

export function InferenceCompare({ runId, rdId, onBack }: { runId: string; rdId: string; onBack: () => void }) {
  const [filter, setFilter] = useState<FilterKey>('ALL');
  const [sort, setSort] = useState<SortKey>('path');
  const [page, setPage] = useState(1);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [showBoxes, setShowBoxes] = useState(true);
  const [showMatched, setShowMatched] = useState(true);
  const [view, setView] = useState<View>(RESET);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [imgError, setImgError] = useState<string | null>(null);
  const [top, setTop] = useState(60);
  const stripRef = useRef<HTMLDivElement>(null);
  // After stepping back across a page boundary, land on that page's last image.
  const landOnLast = useRef(false);

  // Fill the window below the top bar, like DM. The bar can wrap onto two
  // lines on a narrow window, so measure it rather than assume its height.
  useLayoutEffect(() => {
    const bar = document.querySelector('.topbar');
    const measure = () => setTop(bar ? Math.round(bar.getBoundingClientRect().bottom) : 60);
    measure();
    const ro = bar ? new ResizeObserver(measure) : null;
    if (bar && ro) ro.observe(bar);
    window.addEventListener('resize', measure);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
      document.body.style.overflow = overflow;
    };
  }, []);

  const base = `/inference-runs/${runId}/datasets/${rdId}`;
  const { data: info } = useQuery({
    queryKey: ['inference-rd', runId, rdId],
    queryFn: () => apiGet<RunDatasetInfo>(base),
  });
  const { data: list, isLoading: listLoading, error: listError } = useQuery({
    queryKey: ['inference-diffs', runId, rdId, filter, sort, page],
    queryFn: () => apiGetList<DiffListItem>(
      `${base}/diffs?page=${page}&size=${PAGE_SIZE}&sort=${sort}${filter === 'ALL' ? '' : `&kind=${filter}`}`,
    ),
    placeholderData: (prev) => prev,
  });
  const items = list?.data ?? [];
  const total = list?.meta.total ?? 0;
  const safeIndex = Math.min(index, Math.max(items.length - 1, 0));
  const current = items[safeIndex] ?? null;

  useEffect(() => {
    if (list && landOnLast.current) {
      landOnLast.current = false;
      setIndex(Math.max(list.data.length - 1, 0));
    }
  }, [list]);

  const { data: detail } = useQuery({
    queryKey: ['inference-diff', runId, rdId, current?.id],
    enabled: !!current,
    queryFn: () => apiGet<DiffDetail>(`${base}/diffs/${current!.id}`),
  });

  const imageUrl = (id: string) => `/api/v1${base}/diffs/${id}/image`;

  // Load the current image; keep the zoom so the same spot can be checked
  // across images, as DM does. Warm the next one meanwhile.
  useEffect(() => {
    setSelected(null);
    setImgError(null);
    if (!current) { setImg(null); return; }
    let cancelled = false;
    const el = new Image();
    el.onload = () => { if (!cancelled) setImg(el); };
    el.onerror = () => {
      if (!cancelled) { setImg(null); setImgError('The source image could not be loaded — it may have been moved or deleted since the run.'); }
    };
    el.src = imageUrl(current.id);
    const next = items[safeIndex + 1];
    if (next) new Image().src = imageUrl(next.id);
    return () => { cancelled = true; };
    // Keyed on the image alone: a refetch of the same list must not reload it.
  }, [current?.id]);

  // Keep the active thumbnail in view.
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>(`[data-index="${safeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [safeIndex, items]);

  const go = useCallback((delta: number) => {
    const next = safeIndex + delta;
    if (next >= 0 && next < items.length) { setIndex(next); return; }
    if (delta > 0 && page * PAGE_SIZE < total) { setPage(page + 1); setIndex(0); }
    if (delta < 0 && page > 1) { landOnLast.current = true; setPage(page - 1); }
  }, [safeIndex, items.length, page, total]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'arrowright' || k === 'd') { e.preventDefault(); go(1); }
      else if (k === 'arrowleft' || k === 'a') { e.preventDefault(); go(-1); }
      else if (k === 'l') setShowBoxes((v) => !v);
      else if (k === 'm') setShowMatched((v) => !v);
      else if (k === '0') setView(RESET);
      else if (k === 'escape') setSelected(null);
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

  const changeFilter = (f: FilterKey) => { setFilter(f); setPage(1); setIndex(0); };
  const changeSort = (s: SortKey) => { setSort(s); setPage(1); setIndex(0); };
  const position = (page - 1) * PAGE_SIZE + safeIndex + 1;
  const matched = (detail?.matches ?? []).filter((m) => m.kind === 'MATCH').length;
  const differences = (detail?.matches ?? []).map((m, i) => ({ m, i })).filter(({ m }) => m.kind !== 'MATCH');

  const originalBadges = [
    ...(detail?.missing_count ? [{ text: `${detail.missing_count} only here`, color: 'rgba(239,68,68,0.9)' }] : []),
    ...(detail?.class_mismatch_count ? [{ text: `${detail.class_mismatch_count} class differs`, color: 'rgba(245,158,11,0.9)' }] : []),
    ...(detail?.label_invalid ? [{ text: 'unreadable lines', color: 'rgba(127,29,29,0.95)' }] : []),
  ];
  const predictedBadges = [
    ...(detail?.extra_count ? [{ text: `${detail.extra_count} only here`, color: 'rgba(59,130,246,0.9)' }] : []),
    ...(detail?.class_mismatch_count ? [{ text: `${detail.class_mismatch_count} class differs`, color: 'rgba(245,158,11,0.9)' }] : []),
  ];

  // Portalled to <body>: .content animates in with a transform, and a fixed
  // element inside a transformed ancestor is placed against that ancestor
  // instead of the window — the page would sit offset until it settled.
  return createPortal(
    <div
      style={{
        position: 'fixed', top, left: 0, right: 0, bottom: 0, zIndex: 50, display: 'flex', flexDirection: 'column',
        background: C.bg, color: C.text,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          padding: '10px 20px', background: C.panel, borderBottom: `1px solid ${C.line}`, flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
          <button
            onClick={onBack}
            style={{ background: 'transparent', color: C.sub, fontSize: 13, fontWeight: 700, border: `1px solid ${C.line}`, padding: '6px 12px', borderRadius: 6, cursor: 'pointer' }}
          >
            ← Back to run
          </button>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {info?.source_dataset_name ?? '…'}
            </div>
            <div style={{ fontSize: 11, color: C.dim }}>
              {info ? `${info.run_name} · conf ≥ ${info.conf_threshold} · IoU ${info.iou_threshold}` : ''}
            </div>
          </div>
          <span style={{ fontSize: 13, color: C.sub, background: C.well, padding: '4px 8px', borderRadius: 4, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
            {total ? position.toLocaleString() : 0} / {total.toLocaleString()}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Segmented
            options={FILTERS.map((f) => ({ ...f, count: info?.kind_counts[f.key] }))}
            value={filter}
            onChange={changeFilter}
          />
          <Segmented
            options={[
              { key: 'path' as SortKey, label: 'By name', hint: 'In file-name order' },
              { key: 'most' as SortKey, label: 'Most first', hint: 'Images with the most differences first' },
            ]}
            value={sort}
            onChange={changeSort}
          />
          <button style={toolBtn(!showBoxes)} onClick={() => setShowBoxes((v) => !v)} title="Show or hide all boxes (L)">
            {showBoxes ? 'Hide boxes (L)' : 'Show boxes (L)'}
          </button>
          <button style={toolBtn(!showMatched)} onClick={() => setShowMatched((v) => !v)} title="Show or hide boxes that agree on both sides (M)">
            {showMatched ? 'Hide same (M)' : 'Show same (M)'}
          </button>
          <button style={toolBtn()} onClick={() => setView(RESET)} title="Fit the image (0, or double-click)">Reset view</button>
        </div>
      </div>

      {(info?.source_changed || imgError) && (
        <div style={{ padding: '6px 20px', fontSize: 12, background: 'rgba(241,177,26,0.12)', color: '#f1b11a', borderBottom: `1px solid ${C.line}`, flexShrink: 0 }}>
          {imgError ?? 'The source dataset was rescanned after this run. Boxes are shown as they were compared, but the image on disk may have changed since.'}
        </div>
      )}

      {/* Canvases */}
      {current ? (
        <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 2, background: '#000' }}>
          <DiffCanvas
            img={img} imgError={imgError} boxes={originalBoxes} view={view} setView={setView}
            selected={selected} onPick={setSelected} showBoxes={showBoxes} showMatched={showMatched}
            title={`Original labels · ${detail?.original_boxes.length ?? 0}`} badges={originalBadges}
          />
          <DiffCanvas
            img={img} imgError={imgError} boxes={predictedBoxes} view={view} setView={setView}
            selected={selected} onPick={setSelected} showBoxes={showBoxes} showMatched={showMatched}
            title={`Model prediction · ${detail?.predicted_boxes.length ?? 0}`} badges={predictedBadges}
          />
        </div>
      ) : (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: C.sub, fontSize: 14 }}>
          {listError
            ? (listError as Error).message
            : listLoading ? 'Loading…' : filter === 'ALL' ? 'No differing images in this dataset.' : 'No images with this kind of difference.'}
        </div>
      )}

      {/* What differs in this image — each chip selects its pair */}
      {current && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '8px 20px', maxHeight: 76, overflowY: 'auto',
            background: C.panel, borderTop: `1px solid ${C.line}`, flexShrink: 0, fontSize: 12,
          }}
        >
          <code style={{ color: C.sub, marginRight: 8, overflowWrap: 'anywhere' }}>{current.image_relative_path}</code>
          {differences.map(({ m, i }) => {
            const o = m.original !== null ? detail!.original_boxes[m.original] : null;
            const p = m.predicted !== null ? detail!.predicted_boxes[m.predicted] : null;
            const text = m.kind === 'CLASS_MISMATCH'
              ? `${className(o!.class_index)} → ${className(p!.class_index)} ${p!.conf?.toFixed(2) ?? ''}`
              : m.kind === 'MISSING' ? className(o!.class_index) : `${className(p!.class_index)} ${p!.conf?.toFixed(2) ?? ''}`;
            const sel = i === selected;
            return (
              <button
                key={i}
                onClick={() => setSelected(sel ? null : i)}
                title={`${KIND_LABEL[m.kind]}${m.iou !== null ? ` · IoU ${m.iou.toFixed(2)}` : ''}`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11,
                  background: sel ? 'rgba(255,255,255,0.12)' : C.well, color: C.text,
                  border: `1px solid ${sel ? '#fff' : C.line}`, borderRadius: 999, padding: '2px 10px',
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: 2, background: KIND_COLOR[m.kind] }} />
                <span style={{ color: C.sub }}>{KIND_LABEL[m.kind]}:</span> {text.trim()}
              </button>
            );
          })}
          {matched > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.sub, padding: '2px 6px' }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: KIND_COLOR.MATCH }} />
              {matched} same
            </span>
          )}
          <span style={{ marginLeft: 'auto', color: C.dim, fontSize: 11, whiteSpace: 'nowrap' }}>
            ← → images · scroll zoom · drag pan · click a box to pair it
          </span>
        </div>
      )}

      {/* Thumbnail strip: names and marks, like DM — no image loads */}
      {items.length > 0 && (
        <div
          ref={stripRef}
          style={{
            display: 'flex', gap: 8, padding: '10px 12px', background: C.panel, borderTop: `1px solid ${C.line}`,
            overflowX: 'auto', flexShrink: 0, alignItems: 'stretch',
          }}
        >
          {page > 1 && (
            <button style={{ ...toolBtn(), flexShrink: 0 }} onClick={() => { landOnLast.current = true; setPage(page - 1); }}>
              ◀ Previous {PAGE_SIZE}
            </button>
          )}
          {items.map((it, i) => {
            const active = i === safeIndex;
            // Names in one dataset share a long prefix (bac_260421_1_000027.jpg), so
            // cut from the front: the end is the part that tells them apart.
            const full = it.image_relative_path.split('/').pop() ?? it.image_relative_path;
            const name = full.length > 17 ? `…${full.slice(-16)}` : full;
            return (
              <div
                key={it.id}
                data-index={i}
                onClick={() => setIndex(i)}
                title={it.image_relative_path}
                style={{
                  flexShrink: 0, width: 120, padding: 6, borderRadius: 6, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4,
                  border: `2px solid ${active ? C.accent : 'transparent'}`, background: active ? 'rgba(59,130,246,0.2)' : 'transparent',
                }}
              >
                <div style={{ fontSize: 10, color: C.sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                <div style={{ fontSize: 11, fontWeight: 700, display: 'flex', gap: 6, justifyContent: 'center' }}>
                  {it.missing_count > 0 && <span style={{ color: KIND_COLOR.MISSING }}>−{it.missing_count}</span>}
                  {it.extra_count > 0 && <span style={{ color: KIND_COLOR.EXTRA }}>+{it.extra_count}</span>}
                  {it.class_mismatch_count > 0 && <span style={{ color: KIND_COLOR.CLASS_MISMATCH }}>≠{it.class_mismatch_count}</span>}
                  {it.label_invalid && <span style={{ color: '#f87171' }}>!</span>}
                </div>
              </div>
            );
          })}
          {page * PAGE_SIZE < total && (
            <button style={{ ...toolBtn(), flexShrink: 0 }} onClick={() => { setPage(page + 1); setIndex(0); }}>
              Next {PAGE_SIZE} ▶
            </button>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
