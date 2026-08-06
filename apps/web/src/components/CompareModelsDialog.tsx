import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiGetList } from '../lib/api';
import { Modal } from './Modal';
import { PrereqNotice } from './PrereqNotice';

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
    queryFn: () => apiGetList<DatasetType>('/admin/dataset-types?size=100'),
  });
  const datasetTypes = datasetTypesData?.data ?? [];

  const { data: allModelsData, isLoading: isLoadingModels } = useQuery({
    queryKey: ['models-all'],
    queryFn: () => apiGetList<ModelOption>('/models?size=500'),
  });
  const availableModels = (allModelsData?.data ?? []).filter((m) => m.status === 'AVAILABLE');

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
              {datasetTypes.map((dt) => (
                <option key={dt.id} value={dt.id}>{dt.name}</option>
              ))}
            </select>
            <span className="hint" style={{ marginTop: '6px' }}>
              Pick the dataset type whose available models you want to compare side by side.
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
            <CompareChart results={results} modelName={modelName} selectedModelIds={selectedModelIds} />
          )}
        </div>
      )}
    </Modal>
  );
}

function CompareChart({
  results, modelName, selectedModelIds,
}: {
  results: CompareResult[];
  modelName: (id: string) => string;
  selectedModelIds: string[];
}) {
  const byId = useMemo(() => new Map(results.map((r) => [r.model_id, r])), [results]);
  const rows = selectedModelIds.map((id, i) => ({
    id, color: SERIES_COLORS[i % SERIES_COLORS.length], evaluation: byId.get(id)?.evaluation ?? null,
  }));

  const classNames = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) for (const c of r.evaluation?.per_class ?? []) set.add(c.class_name);
    return [...set].sort();
  }, [rows]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
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

