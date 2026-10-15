import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiGet, apiGetList, apiGetAll, apiSend } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { useAuthStore } from '../stores/auth';
import { Modal } from './Modal';
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
  architecture_metadata?: { class_count?: number | null } | null;
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

/**
 * One form rather than a five-step wizard: the choices are few, and seeing
 * them together is what catches a wrong one before the run starts — the reason
 * runs needed deleting in the first place. Datasets whose class count differs
 * from the model's are shown but cannot be picked, since the worker would fail
 * them; names that differ only in spelling are the worker's concern and only
 * warn (docs/inference-compare-plan.md §6.2).
 */
export function NewInferenceRunDialog({ onClose }: { onClose: () => void }) {
  const csrfToken = useAuthStore((s) => s.csrfToken);

  const [datasetTypeId, setDatasetTypeId] = useState('');
  const [modelId, setModelId] = useState<string | null>(null);
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [device, setDevice] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [sourceSearch, setSourceSearch] = useState('');

  const { data: datasetTypesData } = useQuery({
    queryKey: ['dataset-types-options'],
    queryFn: () => apiGet<DatasetType[]>('/dataset-types/options'),
  });
  const { data: allModelsData, isLoading: isLoadingModels } = useQuery({
    queryKey: ['models-all'],
    queryFn: () => apiGetAll<ModelOption>('/models'),
  });
  const usableModels = useMemo(
    () => (allModelsData ?? []).filter((m) => m.status === 'AVAILABLE' && m.task_type === SUPPORTED_TASK),
    [allModelsData],
  );
  const typesWithModels = useMemo(() => {
    const ids = new Set(usableModels.map((m) => m.dataset_type_id));
    return (datasetTypesData ?? []).filter((t) => ids.has(t.id));
  }, [usableModels, datasetTypesData]);

  // One type to choose from is no choice: take it.
  useEffect(() => {
    if (!datasetTypeId && typesWithModels.length === 1) setDatasetTypeId(typesWithModels[0].id);
  }, [datasetTypeId, typesWithModels]);

  const { data: sourcesData, isLoading: isLoadingSources } = useQuery({
    queryKey: ['source-datasets-inference-options', datasetTypeId],
    enabled: !!datasetTypeId,
    queryFn: () => apiGetAll<SourceDatasetOption>(`/source-datasets?dataset_type_id=${datasetTypeId}&status=READY`),
  });

  const { data: workersData } = useQuery({
    queryKey: ['workers'],
    queryFn: () => apiGetList<WorkerRow>('/admin/workers'),
  });

  const model = usableModels.find((m) => m.id === modelId) ?? null;
  const modelClasses = model?.architecture_metadata?.class_count ?? null;

  const typeModels = usableModels
    .filter((m) => m.dataset_type_id === datasetTypeId)
    .filter((m) => {
      const q = modelSearch.toLowerCase();
      return !q || m.name.toLowerCase().includes(q) || (m.version_label ?? '').toLowerCase().includes(q);
    });

  const sources = useMemo(
    () => (sourcesData ?? []).filter((s) => s.status === 'READY' && s.task_type === SUPPORTED_TASK),
    [sourcesData],
  );
  /** Why a dataset cannot be inferred with the chosen model, or null if it can. */
  const blockedReason = (s: SourceDatasetOption): string | null => {
    if (modelClasses == null || s.class_count == null) return null;
    return s.class_count === modelClasses ? null : `${s.class_count} classes — the model has ${modelClasses}`;
  };
  const shownSources = sources.filter((s) => s.name.toLowerCase().includes(sourceSearch.toLowerCase()));
  const pickable = shownSources.filter((s) => !blockedReason(s));
  const chosen = sources.filter((s) => sourceIds.includes(s.id));
  const chosenImages = chosen.reduce((n, s) => n + Number(s.image_count ?? 0), 0);

  // A model change can make chosen datasets incompatible; drop those.
  useEffect(() => {
    setSourceIds((ids) => ids.filter((id) => {
      const s = sources.find((x) => x.id === id);
      return s && !blockedReason(s);
    }));
    // Re-checked when the model or the dataset list changes; blockedReason
    // reads nothing else that changes.
  }, [modelId, sources]);

  // Name follows the choices until the user types their own.
  const suggestedName = model && chosen.length
    ? `${model.name} on ${chosen[0].name}${chosen.length > 1 ? ` +${chosen.length - 1}` : ''}`
    : '';
  useEffect(() => {
    if (!nameTouched) setName(suggestedName);
  }, [suggestedName, nameTouched]);

  const toggleSource = (id: string) =>
    setSourceIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const mutation = useMutation({
    mutationFn: () =>
      apiSend<{ id: string }>('POST', '/inference-runs', {
        name: name.trim(),
        description: description.trim() || undefined,
        model_id: modelId,
        source_dataset_ids: sourceIds,
        device,
      }, csrfToken),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inference-runs'] });
      onClose();
    },
  });

  const missing = !datasetTypeId ? 'Choose a dataset type'
    : !modelId ? 'Choose a model'
    : sourceIds.length === 0 ? 'Choose at least one source dataset'
    : !name.trim() ? 'Give the run a name'
    : null;

  const section: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 };
  const heading: React.CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13, fontWeight: 700, color: 'var(--text)' };
  const stepNo: React.CSSProperties = {
    display: 'inline-grid', placeItems: 'center', width: 20, height: 20, borderRadius: '50%', fontSize: 11,
    background: 'var(--surface-muted)', color: 'var(--text-sub)', flexShrink: 0,
  };
  const sub: React.CSSProperties = { fontSize: 12, color: 'var(--text-sub)', fontWeight: 400 };
  const search: React.CSSProperties = {
    width: '100%', padding: '7px 12px', fontSize: 13, background: 'var(--bg)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 'var(--radius)',
  };
  const empty: React.CSSProperties = { padding: '14px', textAlign: 'center', color: 'var(--text-sub)', fontSize: 13 };

  return (
    <Modal
      title="New Inference Run"
      onClose={onClose}
      className="modal-card-benchmark"
      footer={
        <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 12, color: missing ? 'var(--text-sub)' : 'var(--text)', minWidth: 0 }}>
            {missing ?? (
              <>
                <strong>{model?.name}</strong> on {chosen.length} dataset{chosen.length === 1 ? '' : 's'} ·{' '}
                {chosenImages.toLocaleString()} images · conf ≥ {CONF_THRESHOLD} · IoU {IOU_THRESHOLD}
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={!!missing || mutation.isPending} onClick={() => mutation.mutate()}>
              {mutation.isPending ? 'Starting…' : 'Start Inference'}
            </button>
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {mutation.error && <div className="form-error">{(mutation.error as Error).message}</div>}

        {/* 1. Model */}
        <div style={section}>
          <div style={heading}><span style={stepNo}>1</span>Model</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <select
              aria-label="Dataset type"
              value={datasetTypeId}
              onChange={(e) => { setDatasetTypeId(e.target.value); setModelId(null); setSourceIds([]); }}
              style={{ flex: '0 0 200px' }}
            >
              <option value="">Dataset type…</option>
              {typesWithModels.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <input
              type="text"
              placeholder="🔍 Search models…"
              value={modelSearch}
              onChange={(e) => setModelSearch(e.target.value)}
              style={{ ...search, flex: 1, width: 'auto', minWidth: 160 }}
              disabled={!datasetTypeId}
            />
          </div>
          {!datasetTypeId ? (
            <div style={empty}>Choose a dataset type to see its models. Only types with an available DETECT model are listed.</div>
          ) : isLoadingModels ? (
            <div style={empty}>Loading models…</div>
          ) : typeModels.length === 0 ? (
            <div style={empty}>No available DETECT model matches.</div>
          ) : (
            <div className="checklist" style={{ maxHeight: 170, overflowY: 'auto' }}>
              {typeModels.map((m) => (
                <label key={m.id} className="check-row" style={{ display: 'flex', alignItems: 'center', padding: '7px 12px' }}>
                  <input type="radio" name="inference-model" checked={modelId === m.id} onChange={() => setModelId(m.id)} />
                  <div style={{ marginLeft: 10, flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 13, color: 'var(--text)' }}>
                      {m.name} {m.version_label ? `(${m.version_label})` : ''}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-sub)' }}>
                      {m.architecture_metadata?.class_count != null ? `${m.architecture_metadata.class_count} classes · ` : ''}
                      {m.source_type.toLowerCase()}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* 2. Source datasets */}
        <div style={section}>
          <div style={heading}>
            <span style={stepNo}>2</span>Source datasets
            <span style={sub}>
              {sourceIds.length ? `${sourceIds.length} selected · ${chosenImages.toLocaleString()} images` : ''}
            </span>
          </div>
          {!modelId ? (
            <div style={empty}>Choose a model first — datasets are checked against its classes.</div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  placeholder="🔍 Search datasets…"
                  value={sourceSearch}
                  onChange={(e) => setSourceSearch(e.target.value)}
                  style={{ ...search, flex: 1, width: 'auto', minWidth: 160 }}
                />
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  disabled={pickable.length === 0}
                  onClick={() => setSourceIds((ids) => [...new Set([...ids, ...pickable.map((s) => s.id)])])}
                >
                  Select all{sourceSearch ? ' shown' : ''}
                </button>
                {sourceIds.length > 0 && (
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => setSourceIds([])}>Clear</button>
                )}
              </div>
              {isLoadingSources ? (
                <div style={empty}>Loading source datasets…</div>
              ) : shownSources.length === 0 ? (
                <div style={empty}>No READY DETECT source dataset matches.</div>
              ) : (
                <div className="checklist" style={{ maxHeight: 220, overflowY: 'auto' }}>
                  {shownSources.map((s) => {
                    const reason = blockedReason(s);
                    return (
                      <label
                        key={s.id}
                        className="check-row"
                        title={reason ?? undefined}
                        style={{ display: 'flex', alignItems: 'center', padding: '7px 12px', opacity: reason ? 0.5 : 1, cursor: reason ? 'not-allowed' : 'pointer' }}
                      >
                        <input type="checkbox" disabled={!!reason} checked={sourceIds.includes(s.id)} onChange={() => toggleSource(s.id)} />
                        <div style={{ marginLeft: 10, flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 500, fontSize: 13, color: 'var(--text)' }}>{s.name}</div>
                          <div style={{ fontSize: 11, color: reason ? 'var(--red)' : 'var(--text-sub)' }}>
                            {Number(s.image_count ?? 0).toLocaleString()} images
                            {reason ? ` · ${reason}` : s.class_count != null ? ` · ${s.class_count} classes` : ''}
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

        {/* 3. Run */}
        <div style={section}>
          <div style={heading}><span style={stepNo}>3</span>Run</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 220px', gap: 10 }}>
            <label className="field" style={{ margin: 0 }}>
              <span>Name</span>
              <input
                value={name}
                onChange={(e) => { setName(e.target.value); setNameTouched(true); }}
                placeholder="Filled in from the model and datasets"
              />
            </label>
            <div className="field" style={{ margin: 0 }}>
              <span>Device</span>
              <DevicePicker workers={workersData?.data ?? []} value={device} onChange={setDevice} />
            </div>
          </div>
          <label className="field" style={{ margin: 0 }}>
            <span>Description (optional)</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Why this run, what to look for" />
          </label>
          <div style={{ fontSize: 11, color: 'var(--text-sub)' }}>
            Predictions below confidence {CONF_THRESHOLD} are ignored. An image counts as different when any box has no
            counterpart at IoU {IOU_THRESHOLD}, or its counterpart has another class. Class names that differ only in
            spelling (e.g. "card" and "cards") are allowed and flagged on the run page.
          </div>
        </div>
      </div>
    </Modal>
  );
}
