import { useEffect, useMemo, useState, Children } from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiSend } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { useAuthStore } from '../stores/auth';
import { parseYoloCli, validateExportArgs, ULTRALYTICS_VERSION, type YoloArgIssue } from '@model-trainer/shared-types';

interface Props {
  model: { id: string; name: string; task_type: string; architecture_metadata: Record<string, unknown> };
  onClose: () => void;
  onCreated: (conversionId: string) => void;
}

interface FormState {
  imgsz: number;
  imgszW: number | null;
  dynamic: boolean;
  nms: boolean;
  max_det: number;
  batch: string;
  cliOverride: string | null;
}

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

function TextField({ label, value, onChange, placeholder, hint }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; hint?: string;
}) {
  return (
    <label className="field hp-field">
      <span>{label}</span>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      {hint && <span className="hint">{hint}</span>}
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

function ExportSection({ title, children, defaultOpen = false }: {
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

function buildExportCli(state: FormState, modelFile: string): string {
  const parts: string[] = ['yolo', 'export', `model=${modelFile}`, 'format=openvino'];
  parts.push(`imgsz=${state.imgszW != null ? `${state.imgsz},${state.imgszW}` : state.imgsz}`);
  if (state.dynamic) parts.push('dynamic=True');
  if (state.nms) parts.push('nms=True');
  parts.push(`max_det=${state.max_det}`);
  if (state.batch) parts.push(`batch=${state.batch}`);
  return parts.join(' ');
}

export function ModelConversionWizard({ model, onClose, onCreated }: Props) {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  const trainedImgsz = model.architecture_metadata?.imgsz;
  const [defaultH, defaultW] = Array.isArray(trainedImgsz) ? trainedImgsz : [trainedImgsz, null];
  const defaultImgszH = Number.isFinite(Number(defaultH)) && Number(defaultH) > 0 ? Number(defaultH) : 640;
  const defaultImgszW = Number.isFinite(Number(defaultW)) && Number(defaultW) > 0 ? Number(defaultW) : null;

  const [s, setS] = useState<FormState>({
    imgsz: defaultImgszH,
    imgszW: defaultImgszW,
    dynamic: true,
    nms: false,
    max_det: 300,
    batch: '',
    cliOverride: null,
  });

  const generatedCli = useMemo(() => buildExportCli(s, `${model.name}.pt`), [s, model.name]);
  const cli = s.cliOverride ?? generatedCli;
  const cliEdited = s.cliOverride !== null && s.cliOverride !== generatedCli;

  const { cliIssues, cliStray } = useMemo(() => {
    const { args, strayTokens } = parseYoloCli(cli);
    delete args.model;
    delete args.format;
    return { cliIssues: validateExportArgs(args), cliStray: strayTokens };
  }, [cli]);
  const cliValid = cliIssues.length === 0 && cliStray.length === 0;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !mutation.isPending) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const mutation = useMutation({
    mutationFn: async () => {
      let args: Record<string, unknown>;
      if (s.cliOverride !== null) {
        const { args: parsed } = parseYoloCli(s.cliOverride);
        delete parsed.model;
        delete parsed.format;
        args = parsed;
      } else {
        args = {
          imgsz: s.imgszW != null ? [s.imgsz, s.imgszW] : s.imgsz,
          dynamic: s.dynamic,
          nms: s.nms, max_det: s.max_det,
        };
        if (s.batch) args.batch = Number(s.batch);
      }
      return apiSend<{ id: string }>('POST', `/models/${model.id}/conversions`, { args }, csrfToken);
    },
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['model-conversions', model.id] });
      onCreated(created.id);
      onClose();
    },
  });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card-wizard" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Convert to OpenVINO</h3>
          <button className="btn btn-ghost modal-close" onClick={onClose}>×</button>
        </div>

        <div className="version-summary" style={{ marginBottom: 12 }}>
          <div>Model: <strong>{model.name}</strong> · {model.task_type}</div>
          <div>Output: OpenVINO IR (<code>.xml</code>/<code>.bin</code>) zipped, stored in MinIO</div>
        </div>

        {mutation.error && <div className="form-error">{(mutation.error as Error).message}</div>}

        <div className="hp-container">
          <ExportSection title="Image Size" defaultOpen>
            <IntField label={s.imgszW != null ? 'Image size (height)' : 'Image size (imgsz)'} value={s.imgsz}
              onChange={(v) => setS((p) => ({ ...p, imgsz: v, cliOverride: null }))} min={32} max={4096} step={32} />
            {s.imgszW != null && (
              <IntField label="Image size (width)" value={s.imgszW}
                onChange={(v) => setS((p) => ({ ...p, imgszW: v, cliOverride: null }))} min={32} max={4096} step={32} />
            )}
            <BoolField label="Non-square imgsz" value={s.imgszW != null}
              onChange={(v) => setS((p) => ({ ...p, imgszW: v ? p.imgsz : null, cliOverride: null }))} />
          </ExportSection>

          <ExportSection title="Export Options" defaultOpen>
            <TextField label="Batch" value={s.batch}
              onChange={(v) => setS((p) => ({ ...p, batch: v, cliOverride: null }))}
              placeholder="16 (optional)" />
            <IntField label="Max detections" value={s.max_det}
              onChange={(v) => setS((p) => ({ ...p, max_det: v, cliOverride: null }))} min={1} max={10000} />
            <BoolField label="Dynamic shape" value={s.dynamic} onChange={(v) => setS((p) => ({ ...p, dynamic: v, cliOverride: null }))} />
            <BoolField label="Include NMS" value={s.nms} onChange={(v) => setS((p) => ({ ...p, nms: v, cliOverride: null }))} />
          </ExportSection>
        </div>

        {s.cliOverride === null && s.dynamic && s.nms && !s.batch && (
          <div className="hint" style={{ marginTop: 8 }}>
            Dynamic shape together with NMS works best with an explicit max batch size
            (e.g. <code>batch=16</code>) — Ultralytics warns about this combination otherwise.
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <div className="cli-block">
            <div className="cli-head">
              <span>Export CLI</span>
              <div className="cli-actions">
                {cliEdited && <span className="cli-edited">edited</span>}
                <button className="btn btn-sm btn-ghost" disabled={!cliEdited}
                  onClick={() => setS((p) => ({ ...p, cliOverride: null }))}>Reset</button>
              </div>
            </div>
            <textarea
              className={`cli-editor${cliIssues.length > 0 || cliStray.length > 0 ? ' is-invalid' : ''}`}
              spellCheck={false}
              value={cli}
              onChange={(e) => setS((p) => ({ ...p, cliOverride: e.target.value }))}
            />
            {cliIssues.length > 0 || cliStray.length > 0 ? (
              <ul className="cli-issues">
                {cliStray.map((t) => (
                  <li key={`stray-${t}`}><code>{t}</code> — not a <code>key=value</code> argument</li>
                ))}
                {cliIssues.map((i) => (
                  <li key={i.key}>
                    <code>{i.key}</code> — {i.message}
                    {i.suggestion && <> · did you mean <code>{i.suggestion}</code>?</>}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="hint">
                Every <code>key=value</code> is passed to <code>model.export()</code>. <code>model</code> and{' '}
                <code>format=openvino</code> are fixed by the platform. Checked against Ultralytics{' '}
                {ULTRALYTICS_VERSION}. INT8 (<code>int8</code>/<code>quantize</code>) is not supported — it needs
                a calibration dataset.
              </div>
            )}
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <div className="spacer" />
          <button className="btn btn-primary" disabled={mutation.isPending || !cliValid} onClick={() => mutation.mutate()}>
            {mutation.isPending ? 'Queueing…' : 'Convert'}
          </button>
        </div>
      </div>
    </div>
  );
}
