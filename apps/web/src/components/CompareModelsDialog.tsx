import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiGetAll } from '../lib/api';
import { Modal } from './Modal';
import { PrereqNotice } from './PrereqNotice';
import { MultiModelCurves } from './TrainingCurves';

interface DatasetType {
  id: string;
  name: string;
}

interface ModelOption {
  id: string;
  name: string;
  version_label?: string | null;
  dataset_type_id: string;
  task_type: string;
  source_type: string;
  status: string;
  architecture_metadata?: Record<string, unknown> | null;
  source_training_job_id: string | null;
}

interface PerClassMetric {
  class_index: number;
  class_name: string;
  precision: number;
  recall: number;
  map50: number;
  map50_95: number;
}

interface CompareEvaluation {
  id: string;
  model_name: string;
  training_dataset_id: string;
  training_dataset_name: string;
  finished_at: string;
  map50: number | null;
  map50_95: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  per_class: PerClassMetric[];
}

interface CompareResult {
  model_id: string;
  evaluation: CompareEvaluation | null;
}

const STEPS = ['Dataset Type', 'Select Models', 'Compare'];

// One color per selected model, cycling if more than 6 are chosen.
const SERIES_COLORS = ['#e45d25', '#2f7ff5', '#20c25a', '#9b8cfa', '#e8709a', '#2bb8ac'];

const OVERALL_METRICS: { key: keyof CompareEvaluation; label: string }[] = [
  { key: 'map50', label: 'mAP50' },
  { key: 'map50_95', label: 'mAP50-95' },
  { key: 'precision', label: 'Precision' },
  { key: 'recall', label: 'Recall' },
  { key: 'f1', label: 'F1' },
];

export function CompareModelsDialog({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [datasetTypeId, setDatasetTypeId] = useState('');
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [modelSearch, setModelSearch] = useState('');

  const { data: datasetTypesData } = useQuery({
    queryKey: ['dataset-types-options'],
    queryFn: () => apiGet<DatasetType[]>('/dataset-types/options'),
  });
  const datasetTypes = datasetTypesData ?? [];

  const { data: allModelsData, isLoading: isLoadingModels } = useQuery({
    queryKey: ['models-all'],
    queryFn: () => apiGetAll<ModelOption>('/models'),
  });
  const availableModels = (allModelsData ?? []).filter((m) => m.status === 'AVAILABLE');
  // A type needs at least 2 available models to compare — count per type up front so
  // the Step 0 dropdown can disable types that can never produce a comparison.
  const modelCountByType = new Map<string, number>();
  for (const m of availableModels) modelCountByType.set(m.dataset_type_id, (modelCountByType.get(m.dataset_type_id) ?? 0) + 1);

  // Which of the type's models actually have a COMPLETED evaluation — probed up
  // front so Step 2 can disable the ones that would produce an empty chart.
  const typeModels = availableModels.filter((m) => m.dataset_type_id === datasetTypeId);
  const { data: eligibilityData } = useQuery({
    queryKey: ['compare-eligibility', datasetTypeId, typeModels.map((m) => m.id).join(',')],
    enabled: !!datasetTypeId && typeModels.length > 0,
    queryFn: () =>
      apiGet<{ results: CompareResult[] }>(
        `/benchmark-runs/compare/models?dataset_type_id=${datasetTypeId}&model_ids=${typeModels.map((m) => m.id).join(',')}`,
      ),
  });
  const eligibleIds = new Set(
    (eligibilityData?.results ?? []).filter((r) => r.evaluation).map((r) => r.model_id),
  );

  const { data: compareData, isFetching: isComparing } = useQuery({
    queryKey: ['compare-run', datasetTypeId, selectedModelIds.join(',')],
    enabled: step === 2 && selectedModelIds.length > 0,
    queryFn: () =>
      apiGet<{ results: CompareResult[] }>(
        `/benchmark-runs/compare/models?dataset_type_id=${datasetTypeId}&model_ids=${selectedModelIds.join(',')}`,
      ),
  });

  const filteredModels = typeModels.filter((m) =>
    m.name.toLowerCase().includes(modelSearch.toLowerCase()) ||
    (m.version_label && m.version_label.toLowerCase().includes(modelSearch.toLowerCase())),
  );

  function toggleModel(id: string) {
    setSelectedModelIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const stepDone = (i: number) => {
    if (i === 0) return datasetTypeId !== '';
    if (i === 1) return selectedModelIds.length >= 2;
    return false;
  };
  const canGoTo = (i: number): boolean => {
    if (i <= step) return true;
    for (let j = 0; j < i; j++) if (!stepDone(j)) return false;
    return true;
  };
  const canGoNext = () => stepDone(step);
  const stepVisited = (i: number) => step > i && stepDone(i);

  const results = compareData?.results ?? [];
  const modelName = (id: string) => availableModels.find((m) => m.id === id)?.name ?? id;
  const compareModels = selectedModelIds.map((id, i) => ({
    id,
    name: modelName(id),
    color: SERIES_COLORS[i % SERIES_COLORS.length],
    sourceTrainingJobId: availableModels.find((m) => m.id === id)?.source_training_job_id ?? null,
  }));

  return (
    <Modal
      title="Compare Models"
      onClose={onClose}
      className="modal-card-benchmark"
      footer={
        <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center' }}>
          <button className="btn btn-secondary" onClick={() => {
            if (step === 0) onClose();
            else setStep((s) => s - 1);
          }}>
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          {step < STEPS.length - 1 && (
            <button className="btn btn-primary" disabled={!canGoNext()} onClick={() => setStep((s) => s + 1)}>
              {step === 1 ? 'Compare' : 'Next'}
            </button>
          )}
        </div>
      }
    >
      <div className="wizard-steps" style={{ marginBottom: '16px' }}>
        {STEPS.map((label, i) => (
          <button
            key={label}
            className={`wizard-step${step === i ? ' active' : ''}${stepVisited(i) ? ' done' : ''}`}
            onClick={() => setStep(i)}
            disabled={!canGoTo(i)}
            type="button"
          >
            <span className="wizard-step-num">{stepVisited(i) ? '✓' : i + 1}</span>
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* STEP 0: Dataset Type */}
      {step === 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <label className="field">
            <span>Dataset Type (Required)</span>
            <select
              value={datasetTypeId}
              onChange={(e) => { setDatasetTypeId(e.target.value); setSelectedModelIds([]); }}
            >
              <option value="">-- Select Dataset Type --</option>
              {datasetTypes.map((dt) => {
                const count = modelCountByType.get(dt.id) ?? 0;
                const enough = count >= 2;
                return (
                  <option key={dt.id} value={dt.id} disabled={!enough}>
                    {dt.name}{enough ? '' : ' (needs 2+ models)'}
                  </option>
                );
              })}
            </select>
            <span className="hint" style={{ marginTop: '6px' }}>
              Dataset types with fewer than 2 available models are disabled — nothing to compare yet.
            </span>
          </label>
        </div>
      )}

      {/* STEP 1: Select Models (multi) */}
      {step === 1 && (
        <div>
          {!datasetTypeId ? (
            <PrereqNotice message="Select a Dataset Type first." onGoToStep={() => setStep(0)} />
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px', gap: '10px' }}>
                <input
                  type="text"
                  placeholder="🔍 Search models..."
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  style={{ width: '240px', padding: '7px 12px', fontSize: '13px', background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}
                />
                <span className="hint" style={{ margin: 0 }}>{selectedModelIds.length} selected (min 2)</span>
              </div>

              {isLoadingModels ? (
                <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-sub)' }}>Loading models...</div>
              ) : filteredModels.length === 0 ? (
                <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-sub)' }}>No models found for this Dataset Type.</div>
              ) : (
                <div className="checklist" style={{ maxHeight: '320px', overflowY: 'auto' }}>
                  {filteredModels.map((m) => {
                    const arch = m.architecture_metadata ?? {};
                    const yoloV = arch.yolo_version as string | undefined;
                    const yoloS = arch.yolo_size as string | undefined;
                    const eligible = eligibleIds.has(m.id);
                    const seriesIdx = selectedModelIds.indexOf(m.id);
                    return (
                      <label
                        key={m.id}
                        className="check-row"
                        style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', opacity: eligible ? 1 : 0.45, cursor: eligible ? 'pointer' : 'not-allowed' }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedModelIds.includes(m.id)}
                          disabled={!eligible}
                          onChange={() => toggleModel(m.id)}
                        />
                        <div style={{ marginLeft: '10px', flex: 1 }}>
                          <div style={{ fontWeight: 500, fontSize: '13px', color: 'var(--text)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            {seriesIdx >= 0 && (
                              <span
                                style={{
                                  width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
                                  background: SERIES_COLORS[seriesIdx % SERIES_COLORS.length],
                                }}
                              />
                            )}
                            {m.name} {m.version_label ? `(${m.version_label})` : ''}
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--text-sub)' }}>
                            {yoloV || yoloS ? `${yoloV ?? ''}${yoloV && yoloS ? ' · ' : ''}${yoloS ?? ''} · ` : ''}
                            {m.task_type} · {m.source_type}
                            {!eligible && ' · no completed evaluation for this dataset type'}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* STEP 2: Compare chart */}
      {step === 2 && (
        <div style={{ minHeight: '360px' }}>
          {isComparing ? (
            <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-sub)' }}>Loading results...</div>
          ) : (
            <>
              <CompareChart results={results} modelName={modelName} selectedModelIds={selectedModelIds} datasetTypeName={datasetTypes.find((dt) => dt.id === datasetTypeId)?.name ?? ''} />
              <div style={{ marginTop: '16px' }}>
                <MultiModelCurves models={compareModels} />
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

type Row = { id: string; color: string; evaluation: CompareEvaluation | null };

/** Builds a `model,mAP50,mAP50-95,precision,recall,f1,class,class_map50,...` CSV —
 * one row per model, overall metrics plus every per-class mAP50 as extra columns. */
function toCsv(rows: Row[], modelName: (id: string) => string, classNames: string[]): string {
  const header = ['model', ...OVERALL_METRICS.map((m) => m.label), ...classNames.map((c) => `class:${c}`)];
  const lines = [header.join(',')];
  for (const r of rows) {
    const e = r.evaluation;
    const overall = OVERALL_METRICS.map((m) => (e ? (e[m.key] as number | null) ?? '' : ''));
    const perClass = classNames.map((cn) => e?.per_class.find((pc) => pc.class_name === cn)?.map50 ?? '');
    lines.push([JSON.stringify(modelName(r.id)), ...overall, ...perClass].join(','));
  }
  return lines.join('\n');
}

function downloadBlob(content: string | Blob, filename: string, type: string) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

type ChartMode = 'bars' | 'radar';

function CompareChart({
  results, modelName, selectedModelIds, datasetTypeName,
}: {
  results: CompareResult[];
  modelName: (id: string) => string;
  selectedModelIds: string[];
  datasetTypeName: string;
}) {
  const [mode, setMode] = useState<ChartMode>('radar');
  const captureRef = useRef<HTMLDivElement>(null);
  const byId = useMemo(() => new Map(results.map((r) => [r.model_id, r])), [results]);
  const rows: Row[] = selectedModelIds.map((id, i) => ({
    id, color: SERIES_COLORS[i % SERIES_COLORS.length], evaluation: byId.get(id)?.evaluation ?? null,
  }));

  const classNames = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) for (const c of r.evaluation?.per_class ?? []) set.add(c.class_name);
    return [...set].sort();
  }, [rows]);

  // PNG export only covers the radar view: it's plain SVG (no <foreignObject>), so
  // Chromium/WebKit will actually let toBlob() read it back. The bars view is HTML/CSS
  // and would need foreignObject, which taints the canvas in every browser we support —
  // not worth a canvas 2D re-implementation for a bar chart CSV already covers.
  async function downloadPng() {
    if (mode !== 'radar') return;
    const { svg, width, height } = radarSvgMarkup(rows, modelName);
    const img = new Image();
    const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width * 2;
      canvas.height = height * 2;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.scale(2, 2);
        ctx.fillStyle = '#152033';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((blob) => { if (blob) downloadBlob(blob, `compare-${datasetTypeName || 'models'}.png`, 'image/png'); });
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
        <div className="chart-mode-toggle">
          <button type="button" className={mode === 'radar' ? 'active' : ''} onClick={() => setMode('radar')}>Radar</button>
          <button type="button" className={mode === 'bars' ? 'active' : ''} onClick={() => setMode('bars')}>Bars</button>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => downloadBlob(toCsv(rows, modelName, classNames), `compare-${datasetTypeName || 'models'}.csv`, 'text/csv')}>
            ⬇ CSV
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={mode !== 'radar'}
            title={mode !== 'radar' ? 'Switch to Radar view to export PNG' : undefined}
            onClick={downloadPng}
          >
            ⬇ PNG
          </button>
        </div>
      </div>

      <div ref={captureRef} style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        {mode === 'radar' ? (
          <RadarChart rows={rows} modelName={modelName} />
        ) : (
          <div>
            <h4 style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--text-sub)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
              Overall Metrics
            </h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {OVERALL_METRICS.map((metric) => (
                <MetricGroup key={metric.key} label={metric.label} rows={rows} metric={metric.key} modelName={modelName} />
              ))}
            </div>
          </div>
        )}

        {classNames.length > 0 && (
          <div>
            <h4 style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--text-sub)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
              Per-Class mAP50
            </h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', maxHeight: '280px', overflowY: 'auto', paddingRight: '4px' }}>
              {classNames.map((cn) => (
                <MetricGroup
                  key={cn}
                  label={cn}
                  rows={rows.map((r) => ({
                    ...r,
                    evaluation: r.evaluation
                      ? { ...r.evaluation, map50: r.evaluation.per_class.find((pc) => pc.class_name === cn)?.map50 ?? null }
                      : null,
                  }))}
                  metric="map50"
                  modelName={modelName}
                />
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', paddingTop: '4px', borderTop: '1px solid var(--border)' }}>
          {rows.map((r) => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-sub)' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: r.color, flexShrink: 0 }} />
              {modelName(r.id)}
              {!r.evaluation && ' (no data)'}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const RADAR_SIZE = 320;
const RADAR_CENTER = RADAR_SIZE / 2;
const RADAR_RADIUS = RADAR_SIZE / 2 - 46;
const radarAngleFor = (i: number) => (Math.PI * 2 * i) / OVERALL_METRICS.length - Math.PI / 2;
const radarPointAt = (i: number, value: number) => {
  const a = radarAngleFor(i);
  const r = RADAR_RADIUS * Math.max(0, Math.min(1, value));
  return [RADAR_CENTER + r * Math.cos(a), RADAR_CENTER + r * Math.sin(a)] as const;
};

/** Plain-SVG (no foreignObject) re-render of the radar chart plus a legend row, for PNG
 * export — foreignObject taints the canvas on every browser, so the exported markup
 * can't just be the on-screen chart. */
function radarSvgMarkup(rows: Row[], modelName: (id: string) => string): { svg: string; width: number; height: number } {
  const legendH = 24;
  const width = RADAR_SIZE;
  const height = RADAR_SIZE + legendH * Math.ceil(rows.length / 3);
  const rings = [0.25, 0.5, 0.75, 1];
  const parts: string[] = [];
  for (const ring of rings) {
    const pts = OVERALL_METRICS.map((_, i) => radarPointAt(i, ring).join(',')).join(' ');
    parts.push(`<polygon points="${pts}" fill="none" stroke="#2a3652" stroke-width="1"/>`);
  }
  OVERALL_METRICS.forEach((_, i) => {
    const [x, y] = radarPointAt(i, 1);
    parts.push(`<line x1="${RADAR_CENTER}" y1="${RADAR_CENTER}" x2="${x}" y2="${y}" stroke="#2a3652" stroke-width="1"/>`);
  });
  OVERALL_METRICS.forEach((ax, i) => {
    const [x, y] = radarPointAt(i, 1.16);
    parts.push(`<text x="${x}" y="${y}" fill="#9ba9c3" font-size="11" text-anchor="middle" dominant-baseline="middle">${ax.label}</text>`);
  });
  for (const r of rows.filter((r) => r.evaluation)) {
    const pts = OVERALL_METRICS.map((ax, i) => radarPointAt(i, (r.evaluation![ax.key] as number | null) ?? 0));
    parts.push(`<polygon points="${pts.map((p) => p.join(',')).join(' ')}" fill="${r.color}" fill-opacity="0.16" stroke="${r.color}" stroke-width="2"/>`);
    for (const [i, ax] of OVERALL_METRICS.entries()) {
      const [x, y] = radarPointAt(i, (r.evaluation![ax.key] as number | null) ?? 0);
      parts.push(`<circle cx="${x}" cy="${y}" r="3" fill="${r.color}"/>`);
    }
  }
  rows.forEach((r, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = 12 + col * 105;
    const y = RADAR_SIZE + 16 + row * legendH;
    const label = modelName(r.id).slice(0, 14) + (r.evaluation ? '' : ' (no data)');
    parts.push(`<circle cx="${x}" cy="${y - 4}" r="4" fill="${r.color}"/>`);
    parts.push(`<text x="${x + 10}" y="${y}" fill="#9ba9c3" font-size="11">${label}</text>`);
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#152033"/>${parts.join('')}</svg>`;
  return { svg, width, height };
}

/** Radar/spider chart over the 5 overall metrics (mAP50, mAP50-95, Precision, Recall,
 * F1) — one polygon per model, all metrics already 0-1 so a shared 0-1 radial scale
 * works without normalization. Hand-drawn SVG: no charting library. */
function RadarChart({ rows, modelName }: { rows: Row[]; modelName: (id: string) => string }) {
  const size = RADAR_SIZE;
  const center = RADAR_CENTER;
  const axes = OVERALL_METRICS;
  const pointAt = radarPointAt;
  const rings = [0.25, 0.5, 0.75, 1];

  return (
    <div style={{ display: 'flex', justifyContent: 'center' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {rings.map((ring) => (
          <polygon
            key={ring}
            points={axes.map((_, i) => pointAt(i, ring).join(',')).join(' ')}
            fill="none"
            stroke="var(--border)"
            strokeWidth={1}
          />
        ))}
        {axes.map((_, i) => {
          const [x, y] = pointAt(i, 1);
          return <line key={i} x1={center} y1={center} x2={x} y2={y} stroke="var(--border)" strokeWidth={1} />;
        })}
        {axes.map((ax, i) => {
          const [x, y] = pointAt(i, 1.16);
          return (
            <text key={ax.key} x={x} y={y} fill="var(--text-sub)" fontSize={11} textAnchor="middle" dominantBaseline="middle">
              {ax.label}
            </text>
          );
        })}
        {rows.filter((r) => r.evaluation).map((r) => {
          const pts = axes.map((ax, i) => pointAt(i, (r.evaluation![ax.key] as number | null) ?? 0));
          return (
            <polygon
              key={r.id}
              className="radar-series"
              points={pts.map((p) => p.join(',')).join(' ')}
              fill={r.color}
              fillOpacity={0.16}
              stroke={r.color}
              strokeWidth={2}
            />
          );
        })}
        {rows.filter((r) => r.evaluation).map((r) =>
          axes.map((ax, i) => {
            const [x, y] = pointAt(i, (r.evaluation![ax.key] as number | null) ?? 0);
            return <circle key={`${r.id}-${ax.key}`} cx={x} cy={y} r={3} fill={r.color} />;
          }),
        )}
      </svg>
    </div>
  );
}

function MetricGroup({
  label, rows, metric, modelName,
}: {
  label: string;
  rows: { id: string; color: string; evaluation: CompareEvaluation | null }[];
  metric: keyof CompareEvaluation;
  modelName: (id: string) => string;
}) {
  return (
    <div>
      <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text)', marginBottom: '6px' }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
        {rows.map((r) => {
          const v = r.evaluation ? (r.evaluation[metric] as number | null) : null;
          const pct = v != null ? Math.max(0, Math.min(100, v * 100)) : 0;
          return (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: '140px', fontSize: '11px', color: 'var(--text-sub)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>
                {modelName(r.id)}
              </div>
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{ width: `${pct}%`, background: r.color }}
                />
              </div>
              <div style={{ width: '48px', textAlign: 'right', fontSize: '12px', fontWeight: 600, color: 'var(--text)', flexShrink: 0 }}>
                {v != null ? v.toFixed(3) : '—'}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

