import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiGetList, apiGetAll, apiSend } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { useAuthStore } from '../stores/auth';
import { Modal } from './Modal';
import { PrereqNotice } from './PrereqNotice';
import { DevicePicker, type WorkerRow } from './DevicePicker';

interface DatasetType {
  id: string;
  name: string;
}

interface TrainingDatasetOption {
  id: string;
  name: string;
  dataset_type_id: string;
  task_type: string;
  status: string;
  train_count?: string;
  val_count?: string;
  test_count?: string;
  class_count?: number;
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

const STEPS = ['Dataset Type & Name', 'Select Model', 'Select Dataset', 'Device', 'Review'];

export function NewBenchmarkRunDialog({ onClose }: { onClose: () => void }) {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  const [step, setStep] = useState(0);

  // Form State
  const [datasetTypeId, setDatasetTypeId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const [device, setDevice] = useState('');
  const [deviceTouched, setDeviceTouched] = useState(false);

  // Search Filters inside wizard
  const [modelSearch, setModelSearch] = useState('');
  const [datasetSearch, setDatasetSearch] = useState('');

  // Fetch Dataset Types
  const { data: datasetTypesData } = useQuery({
    queryKey: ['dataset-types-options'],
    queryFn: () => apiGetAll<DatasetType>('/admin/dataset-types'),
  });
  const datasetTypes = datasetTypesData ?? [];

  // Fetch Models (all types, once) — a dataset type without an AVAILABLE model is
  // not a valid benchmark target, so the type dropdown disables those outright.
  const { data: allModelsData, isLoading: isLoadingModels } = useQuery({
    queryKey: ['models-all'],
    queryFn: () => apiGetAll<ModelOption>('/models'),
  });
  const allModels = allModelsData ?? [];
  const availableModels = allModels.filter((m) => m.status === 'AVAILABLE');
  const modelTypeIds = new Set(availableModels.map((m) => m.dataset_type_id));

  // Fetch Ready Training Datasets
  const { data: datasetsData, isLoading: isLoadingDatasets } = useQuery({
    queryKey: ['training-datasets-benchmark-options', datasetTypeId],
    enabled: !!datasetTypeId,
    queryFn: () =>
      apiGetAll<TrainingDatasetOption>(
        `/training-datasets${datasetTypeId ? `?dataset_type_id=${datasetTypeId}` : ''}`,
      ),
  });
  const readyDatasets = (datasetsData ?? []).filter((d) => d.status === 'READY');

  // Live worker + GPU info for the Device and Review steps.
  const { data: workersData } = useQuery({
    queryKey: ['workers'],
    queryFn: () => apiGetList<WorkerRow>('/admin/workers'),
    refetchInterval: step === 3 || step === 4 ? 5000 : false,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const created = await apiSend<{ id: string }>('POST', '/benchmark-runs', {
        name,
        description: description || undefined,
        model_ids: selectedModelId ? [selectedModelId] : [],
        training_dataset_ids: selectedDatasetId ? [selectedDatasetId] : [],
        device,
      }, csrfToken);

      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['benchmark-runs'] });
      onClose();
    },
  });

  const filteredModels = availableModels
    .filter((m) => m.dataset_type_id === datasetTypeId)
    .filter(
      (m) =>
        m.name.toLowerCase().includes(modelSearch.toLowerCase()) ||
        (m.version_label && m.version_label.toLowerCase().includes(modelSearch.toLowerCase())),
    );

  const filteredDatasets = readyDatasets
    .filter((d) => d.dataset_type_id === datasetTypeId)
    .filter((d) => d.name.toLowerCase().includes(datasetSearch.toLowerCase()));

  const stepDone = (i: number) => {
    if (i === 0) return datasetTypeId !== '' && name.trim() !== '';
    if (i === 1) return !!selectedModelId;
    if (i === 2) return !!selectedDatasetId;
    if (i === 3) return deviceTouched;
    return false;
  };

  // Strictly sequential, matching the training wizard: a later step is only reachable
  // once every earlier step is actually done; going back is always allowed.
  const canGoTo = (i: number): boolean => {
    if (i <= step) return true;
    for (let j = 0; j < i; j++) if (!stepDone(j)) return false;
    return true;
  };

  const canGoNext = () => stepDone(step);

  const stepVisited = (i: number) => step > i && stepDone(i);

  return (
    <Modal
      title="New Benchmark Run"
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

          <div style={{ display: 'flex', gap: '8px' }}>
            {step < STEPS.length - 1 && (
              <button
                className="btn btn-primary"
                disabled={!canGoNext()}
                onClick={() => setStep((s) => s + 1)}
              >
                Next
              </button>
            )}
            {step === STEPS.length - 1 && (
              <button
                className="btn btn-primary"
                disabled={mutation.isPending || !selectedModelId || !selectedDatasetId}
                onClick={() => mutation.mutate()}
              >
                {mutation.isPending ? 'Submitting...' : 'Create & Launch Benchmark'}
              </button>
            )}
          </div>
        </div>
      }
    >
      {/* Wizard Progress Steps — clickable only once earlier steps are done */}
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

      {step > 0 && !datasetTypeId && (
        <PrereqNotice message="Select a Dataset Type in Step 1 first — models and datasets are loaded per type." onGoToStep={() => setStep(0)} />
      )}

      {/* STEP 0: Dataset Type & Name */}
      {step === 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <label className="field">
            <span>Dataset Type (Required)</span>
            <select
              value={datasetTypeId}
              onChange={(e) => {
                setDatasetTypeId(e.target.value);
                setSelectedModelId(null);
                setSelectedDatasetId(null);
              }}
            >
              <option value="">-- Select Dataset Type --</option>
              {datasetTypes.map((dt) => {
                const hasModel = modelTypeIds.has(dt.id);
                return (
                  <option key={dt.id} value={dt.id} disabled={!hasModel}>
                    {dt.name}{hasModel ? '' : ' (no available models)'}
                  </option>
                );
              })}
            </select>
            <span className="hint" style={{ marginTop: '6px' }}>
              Dataset types without an available model are disabled — import a model under Models first.
            </span>
          </label>

          <label className="field">
            <span>Benchmark Run Name (Required)</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. YOLOv8 vs YOLO11 Evaluation"
              autoFocus
            />
          </label>

          <label className="field">
            <span>Description (Optional)</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of this benchmark experiment..."
              rows={3}
            />
          </label>
        </div>
      )}

      {/* STEP 1: Select Model */}
      {step === 1 && (
        <div>
          {!datasetTypeId ? (
            <PrereqNotice message="Select a Dataset Type in Step 1 first — models and datasets are loaded per type." onGoToStep={() => setStep(0)} />
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: '10px' }}>
                <input
                  type="text"
                  placeholder="🔍 Search models..."
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  style={{ width: '240px', padding: '7px 12px', fontSize: '13px', background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}
                />
              </div>

              {isLoadingModels ? (
                <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-sub)' }}>Loading available models...</div>
              ) : filteredModels.length === 0 ? (
                <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-sub)' }}>No available models found for this Dataset Type.</div>
              ) : (
                <div className="checklist" style={{ maxHeight: '280px', overflowY: 'auto' }}>
                  {filteredModels.map((m) => {
                    const arch = m.architecture_metadata ?? {};
                    const yoloV = arch.yolo_version as string | undefined;
                    const yoloS = arch.yolo_size as string | undefined;
                    return (
                      <label key={m.id} className="check-row" style={{ display: 'flex', alignItems: 'center', padding: '8px 12px' }}>
                        <input
                          type="radio"
                          checked={selectedModelId === m.id}
                          onChange={() => setSelectedModelId(m.id)}
                        />
                        <div style={{ marginLeft: '10px', flex: 1 }}>
                          <div style={{ fontWeight: 500, fontSize: '13px', color: 'var(--text)' }}>
                            {m.name} {m.version_label ? `(${m.version_label})` : ''}
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--text-sub)' }}>
                            {yoloV || yoloS ? `${yoloV ?? ''}${yoloV && yoloS ? ' · ' : ''}${yoloS ?? ''} · ` : ''}
                            {m.task_type} · {m.source_type}
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

      {/* STEP 2: Select Dataset */}
      {step === 2 && (
        <div>
          {!datasetTypeId ? (
            <PrereqNotice message="Select a Dataset Type in Step 1 first — models and datasets are loaded per type." onGoToStep={() => setStep(0)} />
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: '10px' }}>
                <input
                  type="text"
                  placeholder="🔍 Search datasets..."
                  value={datasetSearch}
                  onChange={(e) => setDatasetSearch(e.target.value)}
                  style={{ width: '240px', padding: '7px 12px', fontSize: '13px', background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}
                />
              </div>

              {isLoadingDatasets ? (
                <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-sub)' }}>Loading ready training datasets...</div>
              ) : filteredDatasets.length === 0 ? (
                <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-sub)' }}>No READY datasets found for this Dataset Type.</div>
              ) : (
                <div className="checklist" style={{ maxHeight: '280px', overflowY: 'auto' }}>
                  {filteredDatasets.map((d) => {
                    const tr = Number(d.train_count ?? 0);
                    const va = Number(d.val_count ?? 0);
                    const te = Number(d.test_count ?? 0);
                    return (
                      <label key={d.id} className="check-row" style={{ display: 'flex', alignItems: 'center', padding: '8px 12px' }}>
                        <input
                          type="radio"
                          checked={selectedDatasetId === d.id}
                          onChange={() => setSelectedDatasetId(d.id)}
                        />
                        <div style={{ marginLeft: '10px', flex: 1 }}>
                          <div style={{ fontWeight: 500, fontSize: '13px', color: 'var(--text)' }}>{d.name}</div>
                          <div style={{ fontSize: '11px', color: 'var(--text-sub)' }}>
                            {tr + va + te} images (T{tr}/V{va}/Te{te}){d.class_count != null ? ` · ${d.class_count} classes` : ''} · {d.task_type}
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

      {/* STEP 3: Device */}
      {step === 3 && (
        // min-height keeps the modal tall enough that the DevicePicker's absolutely
        // positioned dropdown (up to 320px) doesn't get clipped by modal-card's
        // overflow:auto — this step otherwise has almost no other content.
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', minHeight: '360px' }}>
          <div className="field">
            <span>Device</span>
            <DevicePicker
              workers={workersData?.data ?? []}
              value={device}
              onChange={(v) => { setDeviceTouched(true); setDevice(v); }}
            />
            <span className="hint" style={{ marginTop: '6px' }}>
              All evaluations in this run use the same device. Auto-detect lets the worker pick GPU 0 if
              available, else CPU.
            </span>
          </div>
        </div>
      )}

      {/* STEP 4: Review */}
      {step === 4 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {!datasetTypeId ? (
            <PrereqNotice message="Select a Dataset Type in Step 1 first — models and datasets are loaded per type." onGoToStep={() => setStep(0)} />
          ) : (
            <>
          <div style={{ background: 'var(--surface-muted)', padding: '12px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontSize: '13px' }}>
            <div><strong>Run Name:</strong> {name}</div>
            {description && <div style={{ color: 'var(--text-sub)', marginTop: '4px' }}>{description}</div>}
            <div style={{ marginTop: '8px' }}>
              <div><strong>Model:</strong> {availableModels.find((m) => m.id === selectedModelId)?.name ?? '—'}</div>
              <div><strong>Dataset:</strong> {readyDatasets.find((d) => d.id === selectedDatasetId)?.name ?? '—'}</div>
              <div><strong>Device:</strong> {device === '' ? 'auto-detect' : device === 'cpu' ? 'CPU' : `GPU (device=${device})`}</div>
            </div>
          </div>

          {workersData && workersData.data.filter((w) => w.status === 'ONLINE').length > 0 && (
            <div>
              <h4 style={{ margin: '0 0 6px', fontSize: 13, color: 'var(--text-sub)' }}>Workers online</h4>
              <div className="table-wrap">
                <table style={{ fontSize: '12px', margin: 0 }}>
                  <thead>
                    <tr>
                      <th>Worker</th><th>Type</th><th>Status</th><th>Compute</th><th>Jobs</th><th>Ultralytics</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workersData.data.filter((w) => w.status === 'ONLINE').map((w) => (
                      <tr key={w.worker_key}>
                        <td style={{ fontWeight: 500 }}>{w.worker_key}</td>
                        <td>{w.worker_type}</td>
                        <td><span className="badge badge-green">{w.status}</span></td>
                        <td>{w.cuda_version && w.cuda_version !== 'None' ? `CUDA ${w.cuda_version}` : 'CPU only'}</td>
                        <td style={{ textAlign: 'right' }}>{w.active_job_count}</td>
                        <td style={{ color: 'var(--text-sub)' }}>{w.ultralytics_version || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
