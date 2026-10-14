import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiGet, apiGetList, apiGetAll, apiSend } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { useAuthStore } from '../stores/auth';
import { Modal } from './Modal';
import { PrereqNotice } from './PrereqNotice';
import { DevicePicker, type WorkerRow } from './DevicePicker';

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
}

interface SourceDatasetOption {
  id: string;
  name: string;
  dataset_type_id: string;
  task_type: string;
  status: string;
  image_count?: string | number | null;
  class_count?: number | null;
}

// Fixed server-side for now (docs/inference-compare-plan.md §2); shown so the
// user knows what "different" will mean.
const CONF_THRESHOLD = 0.7;
const IOU_THRESHOLD = 0.5;

// Only detection is compared in this phase.
const SUPPORTED_TASK = 'DETECT';

const STEPS = ['Dataset Type & Name', 'Select Model', 'Select Source Datasets', 'Device', 'Review'];

export function NewInferenceRunDialog({ onClose }: { onClose: () => void }) {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  const [step, setStep] = useState(0);

  const [datasetTypeId, setDatasetTypeId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [modelId, setModelId] = useState<string | null>(null);
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [device, setDevice] = useState('');
  const [deviceTouched, setDeviceTouched] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [sourceSearch, setSourceSearch] = useState('');

  const { data: datasetTypesData } = useQuery({
    queryKey: ['dataset-types-options'],
    queryFn: () => apiGet<DatasetType[]>('/dataset-types/options'),
  });
  const datasetTypes = datasetTypesData ?? [];

  const { data: allModelsData, isLoading: isLoadingModels } = useQuery({
    queryKey: ['models-all'],
    queryFn: () => apiGetAll<ModelOption>('/models'),
  });
  const usableModels = (allModelsData ?? []).filter((m) => m.status === 'AVAILABLE' && m.task_type === SUPPORTED_TASK);
  const modelTypeIds = new Set(usableModels.map((m) => m.dataset_type_id));

  const { data: sourcesData, isLoading: isLoadingSources } = useQuery({
    queryKey: ['source-datasets-inference-options', datasetTypeId],
    enabled: !!datasetTypeId,
    queryFn: () => apiGetAll<SourceDatasetOption>(`/source-datasets?dataset_type_id=${datasetTypeId}&status=READY`),
  });
  const readySources = (sourcesData ?? []).filter((s) => s.status === 'READY' && s.task_type === SUPPORTED_TASK);

  const { data: workersData } = useQuery({
    queryKey: ['workers'],
    queryFn: () => apiGetList<WorkerRow>('/admin/workers'),
    refetchInterval: step === 3 || step === 4 ? 5000 : false,
  });

  const mutation = useMutation({
    mutationFn: () =>
      apiSend<{ id: string }>('POST', '/inference-runs', {
        name,
        description: description || undefined,
        model_id: modelId,
        source_dataset_ids: sourceIds,
        device,
      }, csrfToken),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inference-runs'] });
      onClose();
    },
  });

  const filteredModels = usableModels
    .filter((m) => m.dataset_type_id === datasetTypeId)
    .filter((m) => {
      const q = modelSearch.toLowerCase();
      return m.name.toLowerCase().includes(q) || (m.version_label ?? '').toLowerCase().includes(q);
    });
  const filteredSources = readySources.filter((s) => s.name.toLowerCase().includes(sourceSearch.toLowerCase()));
  const selectedImages = readySources
    .filter((s) => sourceIds.includes(s.id))
    .reduce((n, s) => n + Number(s.image_count ?? 0), 0);

  const toggleSource = (id: string) =>
    setSourceIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const stepDone = (i: number) => {
    if (i === 0) return datasetTypeId !== '' && name.trim() !== '';
    if (i === 1) return !!modelId;
    if (i === 2) return sourceIds.length > 0;
    if (i === 3) return deviceTouched;
    return false;
  };
  const canGoTo = (i: number): boolean => {
    if (i <= step) return true;
    for (let j = 0; j < i; j++) if (!stepDone(j)) return false;
    return true;
  };
  const stepVisited = (i: number) => step > i && stepDone(i);

  const searchStyle: React.CSSProperties = {
    width: '240px', padding: '7px 12px', fontSize: '13px', background: 'var(--bg)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 'var(--radius)',
  };
  const emptyStyle: React.CSSProperties = { padding: '20px', textAlign: 'center', color: 'var(--text-sub)' };
  const typeNotice = (
    <PrereqNotice
      message="Select a Dataset Type in Step 1 first — models and source datasets are loaded per type."
      onGoToStep={() => setStep(0)}
    />
  );

  return (
    <Modal
      title="New Inference Run"
      onClose={onClose}
      className="modal-card-benchmark"
      footer={
        <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center' }}>
          <button className="btn btn-secondary" onClick={() => (step === 0 ? onClose() : setStep((s) => s - 1))}>
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          {step < STEPS.length - 1 ? (
            <button className="btn btn-primary" disabled={!stepDone(step)} onClick={() => setStep((s) => s + 1)}>
              Next
            </button>
          ) : (
            <button
              className="btn btn-primary"
              disabled={mutation.isPending || !modelId || sourceIds.length === 0}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? 'Submitting...' : 'Start Inference'}
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

      {mutation.error && (
        <div className="form-error" style={{ marginBottom: '12px' }}>
          {(mutation.error as Error).message}
        </div>
      )}

      {step === 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <label className="field">
            <span>Dataset Type (Required)</span>
            <select
              value={datasetTypeId}
              onChange={(e) => {
                setDatasetTypeId(e.target.value);
                setModelId(null);
                setSourceIds([]);
              }}
            >
              <option value="">-- Select Dataset Type --</option>
              {datasetTypes.map((dt) => {
                const hasModel = modelTypeIds.has(dt.id);
                return (
                  <option key={dt.id} value={dt.id} disabled={!hasModel}>
                    {dt.name}{hasModel ? '' : ' (no available DETECT models)'}
                  </option>
                );
              })}
            </select>
            <span className="hint" style={{ marginTop: '6px' }}>
              Inference compares detection boxes, so only types with an available DETECT model can be chosen.
            </span>
          </label>
          <label className="field">
            <span>Run Name (Required)</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. v12 re-check on Q3 data" autoFocus />
          </label>
          <label className="field">
            <span>Description (Optional)</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </label>
        </div>
      )}

      {step === 1 && (
        <div>
          {!datasetTypeId ? typeNotice : (
            <>
              <div style={{ marginBottom: '10px' }}>
                <input type="text" placeholder="🔍 Search models..." value={modelSearch} onChange={(e) => setModelSearch(e.target.value)} style={searchStyle} />
              </div>
              {isLoadingModels ? (
                <div style={emptyStyle}>Loading available models...</div>
              ) : filteredModels.length === 0 ? (
                <div style={emptyStyle}>No available DETECT models for this Dataset Type.</div>
              ) : (
                <div className="checklist" style={{ maxHeight: '280px', overflowY: 'auto' }}>
                  {filteredModels.map((m) => (
                    <label key={m.id} className="check-row" style={{ display: 'flex', alignItems: 'center', padding: '8px 12px' }}>
                      <input type="radio" checked={modelId === m.id} onChange={() => setModelId(m.id)} />
                      <div style={{ marginLeft: '10px', flex: 1 }}>
                        <div style={{ fontWeight: 500, fontSize: '13px', color: 'var(--text)' }}>
                          {m.name} {m.version_label ? `(${m.version_label})` : ''}
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--text-sub)' }}>{m.task_type} · {m.source_type}</div>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {step === 2 && (
        <div>
          {!datasetTypeId ? typeNotice : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' }}>
                <input type="text" placeholder="🔍 Search source datasets..." value={sourceSearch} onChange={(e) => setSourceSearch(e.target.value)} style={searchStyle} />
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  disabled={filteredSources.length === 0}
                  onClick={() => setSourceIds((ids) => [...new Set([...ids, ...filteredSources.map((s) => s.id)])])}
                >
                  Select all shown
                </button>
                {sourceIds.length > 0 && (
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => setSourceIds([])}>Clear</button>
                )}
                <span style={{ fontSize: '12px', color: 'var(--text-sub)' }}>
                  {sourceIds.length} selected · {selectedImages.toLocaleString()} images
                </span>
              </div>
              {isLoadingSources ? (
                <div style={emptyStyle}>Loading source datasets...</div>
              ) : filteredSources.length === 0 ? (
                <div style={emptyStyle}>No READY DETECT source datasets for this Dataset Type.</div>
              ) : (
                <div className="checklist" style={{ maxHeight: '280px', overflowY: 'auto' }}>
                  {filteredSources.map((s) => (
                    <label key={s.id} className="check-row" style={{ display: 'flex', alignItems: 'center', padding: '8px 12px' }}>
                      <input type="checkbox" checked={sourceIds.includes(s.id)} onChange={() => toggleSource(s.id)} />
                      <div style={{ marginLeft: '10px', flex: 1 }}>
                        <div style={{ fontWeight: 500, fontSize: '13px', color: 'var(--text)' }}>{s.name}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-sub)' }}>
                          {Number(s.image_count ?? 0).toLocaleString()} images
                          {s.class_count != null ? ` · ${s.class_count} classes` : ''}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              )}
              <span className="hint" style={{ display: 'block', marginTop: '8px' }}>
                Each dataset needs the same number of classes as the model, in the same order; a dataset
                with a different count fails and the others still run. Names that differ only in spelling
                (e.g. "card" and "cards") are allowed and shown as a warning on the run page.
              </span>
            </>
          )}
        </div>
      )}

      {step === 3 && (
        // Tall enough that the DevicePicker dropdown is not clipped (see NewBenchmarkRunDialog).
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', minHeight: '360px' }}>
          <div className="field">
            <span>Device</span>
            <DevicePicker
              workers={workersData?.data ?? []}
              value={device}
              onChange={(v) => { setDeviceTouched(true); setDevice(v); }}
            />
            <span className="hint" style={{ marginTop: '6px' }}>
              Every dataset in this run uses the same device. Auto-detect lets the worker pick GPU 0 if available, else CPU.
            </span>
          </div>
        </div>
      )}

      {step === 4 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {!datasetTypeId ? typeNotice : (
            <div style={{ background: 'var(--surface-muted)', padding: '12px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontSize: '13px' }}>
              <div><strong>Run Name:</strong> {name}</div>
              {description && <div style={{ color: 'var(--text-sub)', marginTop: '4px' }}>{description}</div>}
              <div style={{ marginTop: '8px' }}>
                <div><strong>Model:</strong> {usableModels.find((m) => m.id === modelId)?.name ?? '—'}</div>
                <div>
                  <strong>Source datasets:</strong> {sourceIds.length} ({selectedImages.toLocaleString()} images)
                </div>
                <div><strong>Device:</strong> {device === '' ? 'auto-detect' : device === 'cpu' ? 'CPU' : `GPU (device=${device})`}</div>
                <div style={{ marginTop: '8px', color: 'var(--text-sub)' }}>
                  Predictions below confidence {CONF_THRESHOLD} are ignored. An image counts as different when any
                  box has no counterpart at IoU {IOU_THRESHOLD}, or its counterpart has another class.
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
