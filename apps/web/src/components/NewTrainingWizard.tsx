import { useEffect, useMemo, useState, Children } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiGetList, apiGetAll, apiSend, apiGet } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { useAuthStore } from '../stores/auth';
import { formatBytes, toParsableIso } from '../lib/format';
import { PrereqNotice } from './PrereqNotice';
import { SearchableSelect } from './SearchableSelect';
import { DevicePicker, type WorkerRow } from './DevicePicker';
import {
  parseYoloCli, validateYoloArgs, ULTRALYTICS_VERSION, type YoloArgIssue,
} from '@model-trainer/shared-types';

interface DatasetType {
  id: string; name: string;
}

interface DatasetItem {
  id: string; name: string; description: string | null;
  dataset_type_id: string; task_type: string; status: string;
  train_count: string; val_count: string; test_count: string;
  class_count: number; ready_at: string | null;
}

interface ModelItem {
  id: string; name: string; version_label: string | null;
  task_type: string; source_type: string; status: string;
  file_size_bytes: number | null; architecture_metadata: Record<string, unknown>;
  dataset_type_id: string;
}

const STEPS = ['Dataset Type', 'Model', 'Training Dataset', 'Hyperparameters', 'Review & CLI'];

const SIZE_STD = [
  { id: 'n', label: 'n', note: 'nano — fastest' },
  { id: 's', label: 's', note: 'small' },
  { id: 'm', label: 'm', note: 'medium' },
  { id: 'l', label: 'l', note: 'large' },
  { id: 'x', label: 'x', note: 'extra — most accurate' },
] as const;

// v9 scales aren't n/s/m/l/x — Ultralytics ships t/s/m/c/e for this generation only.
const SIZE_V9 = [
  { id: 't', label: 't', note: 'tiny — fastest' },
  { id: 's', label: 's', note: 'small' },
  { id: 'm', label: 'm', note: 'medium' },
  { id: 'c', label: 'c', note: 'compact' },
  { id: 'e', label: 'e', note: 'extra — most accurate' },
] as const;

// v10 adds a "b" (balanced) scale between m and l that no other generation has.
const SIZE_V10 = [
  { id: 'n', label: 'n', note: 'nano — fastest' },
  { id: 's', label: 's', note: 'small' },
  { id: 'm', label: 'm', note: 'medium' },
  { id: 'b', label: 'b', note: 'balanced — wider' },
  { id: 'l', label: 'l', note: 'large' },
  { id: 'x', label: 'x', note: 'extra — most accurate' },
] as const;

/**
 * Ultralytics generations this platform can train against official weights for.
 * Excluded on purpose: v3/v4/v6/v7 aren't unified-trainer citizens (v3/v5 use
 * non-standard filenames, v4/v7 aren't Ultralytics repos, v6 has no published .pt).
 * `obb`: whether Ultralytics publishes `*-obb.pt` for this generation — v9 and v10
 * only ship detection weights, so an OBB dataset can't start from them.
 * `keepV`: whether the weight filename keeps the "v" (yolov8n.pt vs yolo11n.pt).
 */
const YOLO_VERSIONS = [
  { id: 'v8', label: 'YOLOv8', note: 'mature, widest ecosystem', keepV: true, sizes: SIZE_STD, obb: true },
  { id: 'v9', label: 'YOLOv9', note: 'PGI + GELAN', keepV: true, sizes: SIZE_V9, obb: false },
  { id: 'v10', label: 'YOLOv10', note: 'NMS-free, fastest inference', keepV: true, sizes: SIZE_V10, obb: false },
  { id: 'v11', label: 'YOLO11', note: 'better accuracy per FLOP', keepV: false, sizes: SIZE_STD, obb: true },
  { id: 'v12', label: 'YOLO12', note: 'attention-centric, community-maintained', keepV: false, sizes: SIZE_STD, obb: true },
  { id: 'v26', label: 'YOLO26', note: 'newest, NMS-free end-to-end', keepV: false, sizes: SIZE_STD, obb: true },
] as const;

const TASK_SUFFIX: Record<string, string> = {
  OBB: '-obb', DETECT: '', POSE: '-pose', SEGMENT: '-seg', CLASSIFY: '-cls',
};

/** Mirrors Trainer._official_model_name on the worker; keep the two in step. */
function officialWeightName(version: string, size: string, taskType: string): string {
  const v = YOLO_VERSIONS.find((x) => x.id === version) ?? YOLO_VERSIONS[0];
  const stem = v.keepV ? `yolo${v.id}${size}` : `yolo${v.id.replace(/^v/, '')}${size}`;
  return `${stem}${TASK_SUFFIX[taskType] ?? ''}.pt`;
}

function buildYoloCli(state: WizardState, data: { datasetPath?: string; modelPath?: string }): string {
  const parts: string[] = ['yolo', 'train'];
  if (data.datasetPath) parts.push(`data=${data.datasetPath}`);
  if (data.modelPath) parts.push(`model=${data.modelPath}`);
  else parts.push('model=yolov8n.pt');
  parts.push(`epochs=${state.epochs}`, `imgsz=${state.imgsz}`, `batch=${state.batch}`);
  if (state.device) parts.push(`device=${state.device}`);
  if (state.optimizer !== 'auto') parts.push(`optimizer=${state.optimizer}`);
  if (state.lr0) parts.push(`lr0=${state.lr0}`);
  if (state.lrf) parts.push(`lrf=${state.lrf}`);
  if (state.momentum) parts.push(`momentum=${state.momentum}`);
  if (state.weight_decay) parts.push(`weight_decay=${state.weight_decay}`);
  if (state.warmup_epochs) parts.push(`warmup_epochs=${state.warmup_epochs}`);
  if (state.cos_lr) parts.push('cos_lr=True');
  if (state.hsv_h) parts.push(`hsv_h=${state.hsv_h}`);
  if (state.hsv_s) parts.push(`hsv_s=${state.hsv_s}`);
  if (state.hsv_v) parts.push(`hsv_v=${state.hsv_v}`);
  if (state.degrees) parts.push(`degrees=${state.degrees}`);
  if (state.translate) parts.push(`translate=${state.translate}`);
  if (state.scale) parts.push(`scale=${state.scale}`);
  if (state.shear) parts.push(`shear=${state.shear}`);
  if (state.flipud) parts.push(`flipud=${state.flipud}`);
  if (state.fliplr) parts.push(`fliplr=${state.fliplr}`);
  if (state.mosaic) parts.push(`mosaic=${state.mosaic}`);
  if (state.mixup) parts.push(`mixup=${state.mixup}`);
  if (state.copy_paste) parts.push(`copy_paste=${state.copy_paste}`);
  if (state.dropout) parts.push(`dropout=${state.dropout}`);
  if (state.patience) parts.push(`patience=${state.patience}`);
  if (state.seed) parts.push(`seed=${state.seed}`);
  if (state.save_period) parts.push(`save_period=${state.save_period}`);
  if (state.workers) parts.push(`workers=${state.workers}`);
  if (state.deterministic) parts.push('deterministic=True');
  if (state.multi_scale) parts.push(`multi_scale=${state.multi_scale}`);
  if (state.rect) parts.push('rect=True');
  if (state.single_cls) parts.push('single_cls=True');
  if (state.cache) parts.push(`cache=${state.cache}`);
  if (state.val === false) parts.push('val=False');
  return parts.join(' \\\n  ');
}

interface WizardState {
  step: number;
  datasetTypeId: string;
  datasetId: string;
  name: string;
  modelSource: 'OFFICIAL' | 'PRETRAINED';
  yoloVersion: string;
  yoloSize: string;
  baseModelId: string | null;
  cliOverride: string | null;
  device: string;
  epochs: number;
  imgsz: number;
  batch: number;
  optimizer: string;
  lr0: number;
  lrf: number;
  momentum: number;
  weight_decay: number;
  warmup_epochs: number;
  cos_lr: boolean;
  hsv_h: number;
  hsv_s: number;
  hsv_v: number;
  degrees: number;
  translate: number;
  scale: number;
  shear: number;
  flipud: number;
  fliplr: number;
  mosaic: number;
  mixup: number;
  copy_paste: number;
  dropout: number;
  patience: number;
  seed: number;
  save_period: number;
  workers: number;
  deterministic: boolean;
  multi_scale: number;
  rect: boolean;
  single_cls: boolean;
  cache: string;
  val: boolean;
}

const INIT: WizardState = {
  step: 0,
  datasetTypeId: '',
  datasetId: '',
  name: '',
  modelSource: 'OFFICIAL',
  yoloVersion: 'v8',
  yoloSize: 'n',
  baseModelId: null,
  cliOverride: null,
  device: '',
  epochs: 100,
  imgsz: 640,
  batch: 16,
  optimizer: 'auto',
  lr0: 0.01,
  lrf: 0.01,
  momentum: 0.937,
  weight_decay: 0.0005,
  warmup_epochs: 3,
  cos_lr: false,
  hsv_h: 0.015,
  hsv_s: 0.7,
  hsv_v: 0.4,
  degrees: 0,
  translate: 0.1,
  scale: 0.5,
  shear: 0,
  flipud: 0,
  fliplr: 0.5,
  mosaic: 1,
  mixup: 0,
  copy_paste: 0,
  dropout: 0,
  patience: 0,
  seed: 0,
  save_period: -1,
  workers: 8,
  deterministic: false,
  multi_scale: 0,
  rect: false,
  single_cls: false,
  cache: 'False',
  val: true,
};

function IntField({ label, value, onChange, min, max, step }: {
  label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number;
}) {
  return (
    <label className="field hp-field">
      <span>{label}</span>
      <input type="number" value={value} min={min} max={max} step={step}
        onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function FloatField({ label, value, onChange, min, max, step }: {
  label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number;
}) {
  return (
    <label className="field hp-field">
      <span>{label}</span>
      <input type="number" value={value} min={min} max={max} step={step ?? 0.001}
        onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function BoolField({ label, value, onChange }: {
  label: string; value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label className="field hp-field hp-field-row">
      <span>{label}</span>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function SelectField({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}) {
  return (
    <label className="field hp-field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

/**
 * The editable `yolo train ...` command, shown on both the Hyperparameters step (where
 * the values are set) and the Review step (where the job is submitted). Validation is
 * the same spec the API and the worker use, so an argument accepted here is one the
 * training run will actually take.
 */
function CliBlock({ value, edited, issues, strayTokens, onChange, onReset }: {
  value: string;
  edited: boolean;
  issues: YoloArgIssue[];
  strayTokens: string[];
  onChange: (v: string) => void;
  onReset: () => void;
}) {
  const bad = issues.length > 0 || strayTokens.length > 0;
  return (
    <div className="cli-block">
      <div className="cli-head">
        <span>YOLO CLI command</span>
        <div className="cli-actions">
          {edited && <span className="cli-edited">edited</span>}
          <button className="btn btn-sm btn-ghost" disabled={!edited} onClick={onReset}>
            Reset
          </button>
        </div>
      </div>
      <textarea
        className={`cli-editor${bad ? ' is-invalid' : ''}`}
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {bad ? (
        <ul className="cli-issues">
          {strayTokens.map((t) => (
            <li key={`stray-${t}`}>
              <code>{t}</code> — not a <code>key=value</code> argument
            </li>
          ))}
          {issues.map((i) => (
            <li key={i.key}>
              <code>{i.key}</code> — {i.message}
              {i.suggestion && <> · did you mean <code>{i.suggestion}</code>?</>}
            </li>
          ))}
        </ul>
      ) : (
        <div className="hint">
          Edit this and the job runs with exactly these arguments — every <code>key=value</code> is read
          back, so the form stops driving it until you press Reset. Checked against Ultralytics{' '}
          {ULTRALYTICS_VERSION}.
        </div>
      )}
    </div>
  );
}

function HyperparamSection({ title, children, defaultOpen = false }: {
  title: string; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="hp-section">
      <button type="button" className="hp-toggle" onClick={() => setOpen(!open)}>
        <span className={`hp-caret${open ? ' open' : ''}`}>▸</span>
        <span>{title}</span>
        <span className="hp-count">{Children.count(children)}</span>
      </button>
      {open && <div className="hp-grid">{children}</div>}
    </div>
  );
}

export function NewTrainingWizard({ onClose }: { onClose: () => void }) {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  const [s, setS] = useState<WizardState>(INIT);
  // Hyperparameters are pre-filled with valid defaults too; same rule — done only after the user touches one.
  const [hpTouched, setHpTouched] = useState(false);

  function set<K extends keyof WizardState>(k: K, v: WizardState[K]) {
    setS((prev) => ({ ...prev, [k]: v }));
  }

  const { data: typeOptions } = useQuery({
    queryKey: ['dataset-type-options'],
    queryFn: () => apiGet<DatasetType[]>('/dataset-types/options'),
  });

  const selType = typeOptions?.find((t) => t.id === s.datasetTypeId);

  const { data: datasetsData } = useQuery({
    queryKey: ['training-datasets-by-type', s.datasetTypeId],
    queryFn: () => apiGetAll<DatasetItem>(`/training-datasets?dataset_type_id=${s.datasetTypeId}`),
    enabled: !!s.datasetTypeId,
  });

  const readyDatasets = datasetsData?.filter((d) => d.status === 'READY') ?? [];
  const selDataset = readyDatasets.find((d) => d.id === s.datasetId);
  const selectedYoloVersion = YOLO_VERSIONS.find((v) => v.id === s.yoloVersion) ?? YOLO_VERSIONS[0];
  // v9/v10 only ship detection weights — an OBB dataset can't start from them.
  const obbUnsupported = s.modelSource === 'OFFICIAL' && selDataset?.task_type === 'OBB' && !selectedYoloVersion.obb;

  const { data: modelsData } = useQuery({
    queryKey: ['models-by-type', s.datasetTypeId],
    queryFn: () => apiGetAll<ModelItem>(`/models?dataset_type_id=${s.datasetTypeId}&status=AVAILABLE`),
    enabled: !!s.datasetTypeId && s.modelSource === 'PRETRAINED',
  });

  const { data: workersData } = useQuery({
    queryKey: ['workers'],
    queryFn: () => apiGetList<WorkerRow>('/admin/workers'),
    // Live usage while the user is actually looking at the device picker or review step.
    refetchInterval: s.step === 3 || s.step === 4 ? 5000 : false,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const hp: Record<string, unknown> = {
        epochs: s.epochs, imgsz: s.imgsz, batch: s.batch,
        optimizer: s.optimizer, lr0: s.lr0, lrf: s.lrf,
        momentum: s.momentum, weight_decay: s.weight_decay,
        warmup_epochs: s.warmup_epochs, cos_lr: s.cos_lr,
        hsv_h: s.hsv_h, hsv_s: s.hsv_s, hsv_v: s.hsv_v,
        degrees: s.degrees, translate: s.translate, scale: s.scale, shear: s.shear,
        flipud: s.flipud, fliplr: s.fliplr, mosaic: s.mosaic, mixup: s.mixup, copy_paste: s.copy_paste,
        dropout: s.dropout,
        patience: s.patience, seed: s.seed, save_period: s.save_period,
        workers: s.workers, deterministic: s.deterministic, multi_scale: s.multi_scale,
        rect: s.rect, single_cls: s.single_cls, cache: s.cache, val: s.val,
      };
      if (s.device) hp.device = s.device;
      // Record which weights the worker should start from when no registered model is used.
      if (s.modelSource === 'OFFICIAL') {
        hp.model = officialWeightName(s.yoloVersion, s.yoloSize, selDataset?.task_type ?? 'DETECT');
        hp.yolo_version = s.yoloVersion;
        hp.yolo_size = s.yoloSize;
      }
      // A hand-edited command replaces the generated arguments outright.
      if (s.cliOverride !== null) {
        const { args: parsed } = parseYoloCli(s.cliOverride);
        // Both are chosen in earlier steps; the generated command only names them so the
        // command reads like one you could paste, and the worker rejects them anyway.
        delete parsed.data;
        delete parsed.model;
        Object.assign(hp, parsed);
      }
      const name = s.name || `${selType?.name ?? 'Training'} ${new Date().toLocaleDateString()}`;
      const created = await apiSend<{ id: string }>('POST', '/training-jobs', {
        name, training_dataset_id: s.datasetId, base_model_id: s.modelSource === 'PRETRAINED' ? s.baseModelId : null, hyperparameters: hp,
      }, csrfToken);
      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['training-jobs'] });
      onClose();
    },
  });

  // Hand-rolled overlay (not <Modal>), so Escape-to-close has to be wired up here too;
  // otherwise the overlay stays and blocks every click behind it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !mutation.isPending) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, mutation.isPending]);

  const selModel = modelsData?.find((m) => m.id === s.baseModelId);
  const modelsMatchTask = modelsData?.filter((m) => !selDataset || m.task_type === selDataset.task_type) ?? [];

  // The weight the job will actually start from — an official Ultralytics name, or the
  // registered model's own file. Task type comes from the selected dataset.
  const resolvedWeights = s.modelSource === 'OFFICIAL'
    ? officialWeightName(s.yoloVersion, s.yoloSize, selDataset?.task_type ?? 'DETECT')
    : (selModel?.name ?? '');

  const generatedCli = useMemo(
    () => buildYoloCli(s, { datasetPath: selDataset?.name, modelPath: resolvedWeights || undefined }),
    [s, resolvedWeights, selDataset],
  );
  // Once the user edits the command it stops tracking the form; Reset restores the link.
  const yoloCli = s.cliOverride ?? generatedCli;
  const cliEdited = s.cliOverride !== null && s.cliOverride !== generatedCli;

  // The generated command is validated too, not just hand-edits. The form's own controls
  // can drift from the installed Ultralytics — `label_smoothing` was dropped from the
  // library and `multi_scale` turned from a flag into a fraction, and because only edits
  // were checked, the wizard happily built a command the API then rejected at submit with
  // a bare 400. Checking both makes that a visible message on this step instead.
  //
  // `data` and `model` are excluded either way: earlier steps choose them, and the
  // generated command only names them so it reads like something you could paste.
  const { cliIssues, cliStray } = useMemo(() => {
    const { args, strayTokens } = parseYoloCli(yoloCli);
    delete args.data;
    delete args.model;
    return { cliIssues: validateYoloArgs(args), cliStray: strayTokens };
  }, [yoloCli]);
  const cliValid = cliIssues.length === 0 && cliStray.length === 0;

  const stepDone = (i: number) => {
    if (i === 0) return !!s.datasetTypeId;
    if (i === 1) return s.modelSource === 'OFFICIAL' ? !!s.yoloVersion && !!s.yoloSize : !!s.baseModelId;
    if (i === 2) return !!s.datasetId && !obbUnsupported;
    if (i === 3) return hpTouched && s.epochs > 0 && s.imgsz > 0 && s.batch > 0 && cliValid;
    return false;
  };

  // Strictly sequential: a later step is only reachable once every earlier step is
  // actually done (pre-filled defaults don't count — the user must complete each step).
  // Going back is always allowed.
  const canGoTo = (i: number): boolean => {
    if (i <= s.step) return true;
    for (let j = 0; j < i; j++) if (!stepDone(j)) return false;
    return true;
  };

  function canNext(): boolean {
    return stepDone(s.step);
  }

  // Only mark a step "done" (green check) once the user has moved past it —
  // pre-filled defaults being technically valid shouldn't tick a step the
  // user hasn't actually visited yet.
  const stepVisited = (i: number) => s.step > i && stepDone(i);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card-wizard" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>New Training Job</h3>
          <button className="btn btn-ghost modal-close" onClick={onClose}>×</button>
        </div>

        <div className="wizard-steps">
          {STEPS.map((label, i) => (
            <button key={i} className={`wizard-step${s.step === i ? ' active' : ''}${stepVisited(i) ? ' done' : ''}`}
              disabled={!canGoTo(i)}
              onClick={() => setS((p) => ({ ...p, step: i }))}>
              <span className="wizard-step-num">{stepVisited(i) ? '✓' : i + 1}</span>
              <span>{label}</span>
            </button>
          ))}
        </div>

        {mutation.error && <div className="form-error">{(mutation.error as Error).message}</div>}

        <div className="wizard-body">
          {s.step > 0 && !s.datasetTypeId && (
            <PrereqNotice message="Select a Dataset Type in Step 1 first — the following steps depend on it." onGoToStep={() => setS((p) => ({ ...p, step: 0 }))} />
          )}

          {/* Step 0: Dataset Type */}
          {s.step === 0 && (
            <div className="type-grid">
              {typeOptions?.map((t) => (
                <div key={t.id} className={`type-card${s.datasetTypeId === t.id ? ' selected' : ''}`}
                  onClick={() => setS((prev) => ({ ...prev, datasetTypeId: t.id, datasetId: '', baseModelId: null }))}>
                  <h4>{t.name}</h4>
                  <div className="type-card-tasks">Select to configure</div>
                </div>
              ))}
            </div>
          )}

          {/* Step 1: Model — official Ultralytics weights, or one already registered here */}
          {s.step === 1 && s.datasetTypeId && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="field">
                <span>Where does the starting model come from?</span>
                <div className="origin-grid">
                  <div
                    className={`origin-card${s.modelSource === 'OFFICIAL' ? ' selected' : ''}`}
                    onClick={() => { setS((prev) => ({ ...prev, modelSource: 'OFFICIAL', baseModelId: null, cliOverride: null })); }}
                  >
                    <div className="origin-card-name">Official YOLO model</div>
                    <p className="origin-card-desc">
                      Ultralytics pretrained weights, downloaded by the training worker on first use.
                    </p>
                  </div>
                  <div
                    className={`origin-card${s.modelSource === 'PRETRAINED' ? ' selected' : ''}`}
                    onClick={() => { setS((prev) => ({ ...prev, modelSource: 'PRETRAINED', cliOverride: null })); }}
                  >
                    <div className="origin-card-name">Model registered here</div>
                    <p className="origin-card-desc">
                      Continue from a model already in this platform — imported, or produced by an earlier run.
                    </p>
                  </div>
                </div>
              </div>

              {s.modelSource === 'OFFICIAL' && (
                <>
                  <div className="field">
                    <span>Version</span>
                    <div className="choice-row">
                      {YOLO_VERSIONS.map((v) => (
                        <button
                          key={v.id}
                          className={`choice${s.yoloVersion === v.id ? ' selected' : ''}`}
                          onClick={() => setS((prev) => ({
                            ...prev, yoloVersion: v.id, cliOverride: null,
                            yoloSize: v.sizes.some((z) => z.id === prev.yoloSize) ? prev.yoloSize : v.sizes[0].id,
                          }))}
                        >
                          {v.label}
                          <span className="choice-sub">{v.note}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="field">
                    <span>Model size</span>
                    <div className="choice-row">
                      {selectedYoloVersion.sizes.map((z) => (
                        <button
                          key={z.id}
                          className={`choice${s.yoloSize === z.id ? ' selected' : ''}`}
                          onClick={() => setS((prev) => ({ ...prev, yoloSize: z.id, cliOverride: null }))}
                        >
                          {z.label}
                          <span className="choice-sub">{z.note}</span>
                        </button>
                      ))}
                    </div>
                    <span className="hint">
                      Larger models train and infer more slowly but usually score higher. Start at n or s.
                    </span>
                  </div>

                  <div className="model-detail-box">
                    <div>
                      Weights: <code>{officialWeightName(s.yoloVersion, s.yoloSize, selDataset?.task_type ?? 'DETECT')}</code>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-sub)', marginTop: 4 }}>
                      {selDataset
                        ? `Task suffix follows the ${selDataset.task_type} dataset picked in the next step.`
                        : 'The task suffix is finalised once you pick the training dataset in the next step.'}
                    </div>
                  </div>
                </>
              )}

              {s.modelSource === 'PRETRAINED' && (
                <>
                  <label className="field">
                    <span>Registered model</span>
                    <select value={s.baseModelId ?? ''} onChange={(e) => { setS((prev) => ({ ...prev, baseModelId: e.target.value || null, cliOverride: null })); }}>
                      <option value="">Select model…</option>
                      {(modelsData ?? []).map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}{m.version_label ? ` (${m.version_label})` : ''} · {m.task_type} · {formatBytes(m.file_size_bytes)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {(modelsData ?? []).length === 0 && (
                    <div className="warn-banner">
                      No AVAILABLE models for this dataset type yet. Import one under Models, or switch to an
                      official YOLO model above.
                    </div>
                  )}
                  {selModel && (
                    <div className="model-detail-box">
                      <div><strong>{selModel.name}</strong> {selModel.version_label ? `v${selModel.version_label}` : ''}</div>
                      <div>Task: {selModel.task_type} · Source: {selModel.source_type} · Size: {formatBytes(selModel.file_size_bytes)}</div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Step 2: Training Dataset */}
          {s.step === 2 && s.datasetTypeId && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="field">
                <span>Training dataset</span>
                <SearchableSelect
                  options={readyDatasets.map((d) => ({
                    value: d.id,
                    label: d.name,
                    hint: `${d.task_type} · ${Number(d.train_count) + Number(d.val_count) + Number(d.test_count)} images (T${Number(d.train_count)}/V${Number(d.val_count)}/Te${Number(d.test_count)}) · ${d.class_count} classes`,
                  }))}
                  value={s.datasetId}
                  onChange={(v) => setS((prev) => ({ ...prev, datasetId: v, cliOverride: null }))}
                  placeholder="Select dataset…"
                  searchable
                />
              </div>
              {readyDatasets.length === 0 && (
                <div className="warn-banner">
                  No READY training datasets for <strong>{selType?.name}</strong>. Build or register one under
                  Training Datasets first — only READY datasets can be trained on.
                </div>
              )}
              {selDataset && (
                <div className="version-summary">
                  <div>Images: {Number(selDataset.train_count) + Number(selDataset.val_count) + Number(selDataset.test_count)} (Train {Number(selDataset.train_count)} · Val {Number(selDataset.val_count)} · Test {Number(selDataset.test_count)})</div>
                  <div>Classes: {selDataset.class_count} · Ready: {selDataset.ready_at ? new Date(toParsableIso(selDataset.ready_at)).toLocaleDateString() : 'N/A'}</div>
                </div>
              )}
              {selDataset && s.modelSource === 'PRETRAINED' && selModel && selModel.task_type !== selDataset.task_type && (
                <div className="error-banner">
                  Task type mismatch: model is {selModel.task_type}, dataset is {selDataset.task_type}. Go back and
                  pick a matching model.
                </div>
              )}
              {obbUnsupported && (
                <div className="error-banner">
                  {selectedYoloVersion.label} has no official OBB weights. Go back to Model and pick a version
                  that supports OBB (v8, v11, v12, or v26).
                </div>
              )}
              <label className="field">
                <span>Job name</span>
                <input value={s.name} onChange={(e) => set('name', e.target.value)}
                  placeholder={selType ? `${selType.name} ${new Date().toLocaleDateString()}` : ''} />
                <span className="hint">Leave blank to auto-name from the dataset type and today's date.</span>
              </label>
            </div>
          )}

          {/* Step 3: Hyperparameters */}
          {s.step === 3 && s.datasetTypeId && (
            <>
            <div className="field" style={{ marginBottom: 12 }}>
              <span>Device</span>
              <DevicePicker
                workers={workersData?.data ?? []}
                value={s.device}
                onChange={(v) => { setHpTouched(true); setS((prev) => ({ ...prev, device: v, cliOverride: null })); }}
              />
            </div>
            <div className="hp-container">
              <HyperparamSection title="Basic">
                <IntField label="Epochs" value={s.epochs} onChange={(v) => { setHpTouched(true); set('epochs', v); }} min={1} max={1000} />
                <IntField label="Image size" value={s.imgsz} onChange={(v) => { setHpTouched(true); set('imgsz', v); }} min={32} max={4096} step={32} />
                <IntField label="Batch" value={s.batch} onChange={(v) => { setHpTouched(true); set('batch', v); }} min={1} max={1024} />
                <SelectField label="Cache" value={s.cache} onChange={(v) => { setHpTouched(true); set('cache', v); }}
                  options={[{ value: 'False', label: 'False' }, { value: 'True', label: 'True (RAM)' }, { value: 'disk', label: 'Disk' }]} />
                <BoolField label="Val during training" value={s.val} onChange={(v) => { setHpTouched(true); set('val', v); }} />
              </HyperparamSection>

              <HyperparamSection title="Optimizer">
                <SelectField label="Optimizer" value={s.optimizer} onChange={(v) => { setHpTouched(true); set('optimizer', v); }}
                  options={[{ value: 'auto', label: 'Auto' }, { value: 'SGD', label: 'SGD' }, { value: 'Adam', label: 'Adam' }, { value: 'AdamW', label: 'AdamW' }, { value: 'Adamax', label: 'Adamax' }, { value: 'Nadam', label: 'Nadam' }, { value: 'RMSprop', label: 'RMSprop' }]} />
                <FloatField label="LR (lr0)" value={s.lr0} onChange={(v) => { setHpTouched(true); set('lr0', v); }} min={1e-6} max={1} />
                <FloatField label="LR final (lrf)" value={s.lrf} onChange={(v) => { setHpTouched(true); set('lrf', v); }} min={1e-6} max={1} />
                <FloatField label="Momentum" value={s.momentum} onChange={(v) => { setHpTouched(true); set('momentum', v); }} min={0} max={1} />
                <FloatField label="Weight decay" value={s.weight_decay} onChange={(v) => { setHpTouched(true); set('weight_decay', v); }} min={0} max={1} />
                <IntField label="Warmup epochs" value={s.warmup_epochs} onChange={(v) => { setHpTouched(true); set('warmup_epochs', v); }} min={0} max={100} />
                <BoolField label="Cosine LR scheduler" value={s.cos_lr} onChange={(v) => { setHpTouched(true); set('cos_lr', v); }} />
              </HyperparamSection>

              <HyperparamSection title="Augmentation">
                <FloatField label="HSV-Hue" value={s.hsv_h} onChange={(v) => { setHpTouched(true); set('hsv_h', v); }} min={0} max={1} />
                <FloatField label="HSV-Saturation" value={s.hsv_s} onChange={(v) => { setHpTouched(true); set('hsv_s', v); }} min={0} max={1} />
                <FloatField label="HSV-Value" value={s.hsv_v} onChange={(v) => { setHpTouched(true); set('hsv_v', v); }} min={0} max={1} />
                <FloatField label="Degrees" value={s.degrees} onChange={(v) => { setHpTouched(true); set('degrees', v); }} min={0} max={180} />
                <FloatField label="Translate" value={s.translate} onChange={(v) => { setHpTouched(true); set('translate', v); }} min={0} max={1} />
                <FloatField label="Scale" value={s.scale} onChange={(v) => { setHpTouched(true); set('scale', v); }} min={0} max={10} />
                <FloatField label="Shear" value={s.shear} onChange={(v) => { setHpTouched(true); set('shear', v); }} min={0} max={180} />
                <FloatField label="Flip up-down" value={s.flipud} onChange={(v) => { setHpTouched(true); set('flipud', v); }} min={0} max={1} />
                <FloatField label="Flip left-right" value={s.fliplr} onChange={(v) => { setHpTouched(true); set('fliplr', v); }} min={0} max={1} />
                <FloatField label="Mosaic" value={s.mosaic} onChange={(v) => { setHpTouched(true); set('mosaic', v); }} min={0} max={1} />
                <FloatField label="MixUp" value={s.mixup} onChange={(v) => { setHpTouched(true); set('mixup', v); }} min={0} max={1} />
                <FloatField label="Copy-paste" value={s.copy_paste} onChange={(v) => { setHpTouched(true); set('copy_paste', v); }} min={0} max={1} />
              </HyperparamSection>

              <HyperparamSection title="Regularization">
                <FloatField label="Dropout" value={s.dropout} onChange={(v) => { setHpTouched(true); set('dropout', v); }} min={0} max={1} />
                <IntField label="Patience (early stop)" value={s.patience} onChange={(v) => { setHpTouched(true); set('patience', v); }} min={0} max={1000} />
                <BoolField label="Single class" value={s.single_cls} onChange={(v) => { setHpTouched(true); set('single_cls', v); }} />
              </HyperparamSection>

              <HyperparamSection title="Advanced">
                <IntField label="Data workers" value={s.workers} onChange={(v) => { setHpTouched(true); set('workers', v); }} min={0} max={64} />
                <IntField label="Random seed" value={s.seed} onChange={(v) => { setHpTouched(true); set('seed', v); }} min={0} max={999999} />
                <IntField label="Save period" value={s.save_period} onChange={(v) => { setHpTouched(true); set('save_period', v); }} min={-1} max={100} />
                <BoolField label="Deterministic" value={s.deterministic} onChange={(v) => { setHpTouched(true); set('deterministic', v); }} />
                <FloatField label="Multi-scale" value={s.multi_scale} onChange={(v) => { setHpTouched(true); set('multi_scale', v); }} min={0} max={1} />
                <BoolField label="Rectangular training" value={s.rect} onChange={(v) => { setHpTouched(true); set('rect', v); }} />
              </HyperparamSection>
            </div>

            {/* The command reflects the fields above as they change, and can be edited
                here instead — the two are the same job, expressed either way. */}
            <div style={{ marginTop: 14 }}>
              <CliBlock
                value={yoloCli}
                edited={cliEdited}
                issues={cliIssues}
                strayTokens={cliStray}
                onChange={(v) => { setHpTouched(true); setS((prev) => ({ ...prev, cliOverride: v })); }}
                onReset={() => setS((prev) => ({ ...prev, cliOverride: null }))}
              />
            </div>
            </>
          )}

          {/* Step 4: Review — the CLI is the source of truth once edited */}
          {s.step === 4 && s.datasetTypeId && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {selDataset && (
                <div className="version-summary">
                  <div>Dataset: <strong>{selDataset.name}</strong> · {Number(selDataset.train_count) + Number(selDataset.val_count) + Number(selDataset.test_count)} images · T{Number(selDataset.train_count)}/V{Number(selDataset.val_count)}/Te{Number(selDataset.test_count)} · {selDataset.class_count} classes</div>
                  <div>Model: <strong>{resolvedWeights || '—'}</strong>{s.modelSource === 'OFFICIAL' ? ' (official, auto-downloaded)' : ' (registered here)'}</div>
                  <div>Device: {s.device || 'auto-detect'}</div>
                </div>
              )}

              <CliBlock
                value={yoloCli}
                edited={cliEdited}
                issues={cliIssues}
                strayTokens={cliStray}
                onChange={(v) => setS((prev) => ({ ...prev, cliOverride: v }))}
                onReset={() => setS((prev) => ({ ...prev, cliOverride: null }))}
              />

              {workersData && workersData.data.filter((w) => w.status === 'ONLINE').length > 0 && (
                <div>
                  <h4 style={{ margin: '0 0 6px', fontSize: 13, color: 'var(--text-sub)' }}>Workers online</h4>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Worker</th><th>Type</th><th>Status</th><th>Compute</th><th>Jobs</th><th>Ultralytics</th>
                        </tr>
                      </thead>
                      <tbody>
                        {workersData.data.filter((w) => w.status === 'ONLINE').map((w) => (
                          <tr key={w.worker_key}>
                            <td className="cell-title">{w.worker_key}</td>
                            <td>{w.worker_type}</td>
                            <td><span className="badge badge-green">{w.status}</span></td>
                            <td>{w.cuda_version && w.cuda_version !== 'None' ? `CUDA ${w.cuda_version}` : 'CPU only'}</td>
                            <td className="nums">{w.active_job_count}</td>
                            <td className="cell-sub">{w.ultralytics_version || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={() => {
            if (s.step === 0) onClose();
            else setS((p) => ({ ...p, step: p.step - 1 }));
          }}>
            {s.step === 0 ? 'Cancel' : 'Back'}
          </button>
          <div className="spacer" />
          {s.step < 4 ? (
            <button className="btn btn-primary" disabled={!canNext()}
              onClick={() => setS((p) => ({ ...p, step: p.step + 1 }))}>
              Next
            </button>
          ) : (
            <button className="btn btn-primary" disabled={mutation.isPending || !cliValid}
              onClick={() => mutation.mutate()}>
              {mutation.isPending ? 'Creating…' : 'Create & Submit'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
