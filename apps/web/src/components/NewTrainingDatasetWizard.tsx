import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiGet, apiGetList, apiSend } from '../lib/api';
import { useAuthStore } from '../stores/auth';
import { queryClient } from '../lib/queryClient';
import { EmptyState } from './EmptyState';
import { FileBrowser } from './FileBrowser';
import { PathDisplay } from './PathDisplay';
import { PrereqNotice } from './PrereqNotice';

type Origin = 'BUILT' | 'REGISTERED';
type TaskType = 'OBB' | 'DETECT';

interface TypeItem {
  id: string;
  name: string;
}

interface SourceDataset {
  id: string;
  name: string;
  sub_path: string | null;
  relative_path: string;
  task_type: string;
  status: string;
  dataset_type_id: string;
  image_count: string | null;
  matched_pair_count: string | null;
}

interface ClassEntry {
  class_index: number;
  class_name: string;
  present_in_sources: string[];
}

interface ValidateResult {
  compatible: boolean;
  source_count: number;
  total_image_count: number;
  merged_classes: ClassEntry[];
  conflicts: Array<{
    class_index: number;
    class_name_a: string;
    class_name_b: string;
    source_a: string;
    source_b: string;
  }>;
}

/** Common train/val/test splits, so the usual case is one click rather than three inputs. */
const RATIO_PRESETS: Array<{ label: string; ratios: [number, number, number] }> = [
  { label: '80 / 10 / 10', ratios: [0.8, 0.1, 0.1] },
  { label: '70 / 20 / 10', ratios: [0.7, 0.2, 0.1] },
  { label: '80 / 20 / 0', ratios: [0.8, 0.2, 0] },
  { label: '90 / 10 / 0', ratios: [0.9, 0.1, 0] },
  // Equal thirds. Sums to 0.9999999999999998, inside both the client's 1e-6 and the
  // API's 1e-5 tolerance.
  { label: '1 / 1 / 1', ratios: [1 / 3, 1 / 3, 1 / 3] },
];

/**
 * Below this share of the data going to train, warn about overfitting. Threshold rather
 * than an equality test against the 1/1/1 preset, so typing the ratios by hand warns too.
 */
const LOW_TRAIN_RATIO = 0.5;

const NAME_RE = /^[a-zA-Z0-9_-]{1,255}$/;

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/**
 * Next selection after clicking row `index`.
 *
 * Plain click toggles that one row. Shift-click applies the clicked row's *resulting*
 * state to the whole span between the anchor and it — the file-manager convention, so
 * shift-clicking an unselected row selects the range and shift-clicking a selected one
 * deselects it. With no anchor yet, shift behaves like a plain click.
 */
function pickSources<T extends { id: string }>(
  rows: T[], selected: string[], index: number, anchor: number | null, shift: boolean,
): string[] {
  const target = !selected.includes(rows[index].id);
  if (!shift || anchor === null) {
    return toggle(selected, rows[index].id);
  }
  const [from, to] = anchor <= index ? [anchor, index] : [index, anchor];
  const span = rows.slice(from, to + 1).map((r) => r.id);
  const next = new Set(selected);
  for (const id of span) {
    if (target) next.add(id);
    else next.delete(id);
  }
  // Preserve the list order rather than the click order, so the summary reads predictably.
  return rows.filter((r) => next.has(r.id)).map((r) => r.id);
}

export function NewTrainingDatasetWizard({ onClose }: { onClose: () => void }) {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  const [step, setStep] = useState(0);

  const [typeId, setTypeId] = useState('');
  const [origin, setOrigin] = useState<Origin>('BUILT');
  const [name, setName] = useState('');
  const [nameTaken, setNameTaken] = useState<boolean | null>(null);
  const [taskType, setTaskType] = useState<TaskType>('OBB');

  // BUILT
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [sourceSearch, setSourceSearch] = useState('');
  // Anchor for shift-click range selection: the last row toggled without shift.
  const [lastPicked, setLastPicked] = useState<number | null>(null);
  const shiftHeld = useRef(false);
  const [validation, setValidation] = useState<ValidateResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [valError, setValError] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<'RANDOM' | 'SAME'>('RANDOM');
  const [ratios, setRatios] = useState<[number, number, number]>([0.8, 0.1, 0.1]);
  const [seed, setSeed] = useState(42);
  const [ack, setAck] = useState(false);
  const [targets, setTargets] = useState<string[]>(['train', 'val']);
  // Defaults alone don't count — the Split step only counts once the user actually
  // interacts with it, mirroring the training wizard's touched-based gating.
  const [splitTouched, setSplitTouched] = useState(false);

  // REGISTERED
  const [relPath, setRelPath] = useState('');
  const [browsing, setBrowsing] = useState(false);

  const [submitError, setSubmitError] = useState<string | null>(null);

  const { data: types } = useQuery({
    queryKey: ['dt-for-wizard'],
    queryFn: () => apiGet<TypeItem[]>('/dataset-types/options'),
    staleTime: 0,
  });

  // Query the registered source datasets rather than /by-type, which lists top-level
  // folders on disk and so misses any source registered at a deeper sub_path.
  const { data: sources } = useQuery({
    queryKey: ['source-datasets', 'for-build', typeId],
    queryFn: async () =>
      (await apiGetList<SourceDataset>(`/source-datasets?size=200&dataset_type_id=${typeId}`)).data,
    staleTime: 0,
    enabled: origin === 'BUILT' && !!typeId,
  });

  const activeType = types?.find((t) => t.id === typeId);

  // How many READY sources this type has per task type, so the Details step can rule out
  // a task type nothing can be built from rather than letting the user discover it two
  // steps later on an empty Sources list. Only meaningful for BUILT — a REGISTERED
  // dataset points at a prepared directory and consults no source datasets at all.
  const readyByTask: Record<TaskType, number> = { OBB: 0, DETECT: 0 };
  for (const s of sources ?? []) {
    if (s.status === 'READY' && (s.task_type === 'OBB' || s.task_type === 'DETECT')) {
      readyByTask[s.task_type] += 1;
    }
  }
  // While the query is in flight `sources` is undefined; gating then would flicker every
  // option to disabled, so gate only once a result has arrived.
  const gateTaskTypes = origin === 'BUILT' && sources !== undefined;
  const taskTypeAvailable = (t: TaskType) => !gateTaskTypes || readyByTask[t] > 0;
  const noSourcesAtAll = gateTaskTypes && readyByTask.OBB === 0 && readyByTask.DETECT === 0;

  // If the default (or a previously picked) task type has nothing behind it, move to the
  // one that does. Never overrides a choice the user could actually have made.
  useEffect(() => {
    if (!gateTaskTypes || noSourcesAtAll) return;
    if (readyByTask[taskType] > 0) return;
    const other: TaskType = taskType === 'OBB' ? 'DETECT' : 'OBB';
    if (readyByTask[other] > 0) setTaskType(other);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateTaskTypes, noSourcesAtAll, readyByTask.OBB, readyByTask.DETECT, taskType]);
  // The API requires every source to share the dataset's task type, so filter here
  // instead of letting build-config reject the selection afterwards.
  const readySources = (sources ?? []).filter((s) => s.status === 'READY' && s.task_type === taskType);

  const [train, val, test] = ratios;
  const ratioSum = train + val + test;
  const ratiosValid = Math.abs(ratioSum - 1) < 1e-6 && train > 0 && val >= 0 && test >= 0;
  const nameValid = NAME_RE.test(name);

  // Debounced uniqueness check against create()'s own dup rule — surfaces "name taken"
  // while typing instead of only when Create & Build submits.
  useEffect(() => {
    if (!nameValid || !typeId) { setNameTaken(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await apiGet<{ available: boolean }>(
          `/training-datasets/name-available?name=${encodeURIComponent(name)}&dataset_type_id=${typeId}`,
        );
        if (!cancelled) setNameTaken(!r.available);
      } catch {
        if (!cancelled) setNameTaken(null);
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [name, typeId, nameValid]);

  const STEPS = origin === 'BUILT'
    ? ['Type & Origin', 'Details', 'Sources', 'Classes', 'Split']
    : ['Type & Origin', 'Details', 'Directory'];
  const lastStep = STEPS.length - 1;

  const validateMut = useMutation({
    mutationFn: (ids: string[]) =>
      apiSend<ValidateResult>('POST', '/source-datasets/validate-classes', { source_dataset_ids: ids }, csrfToken),
    onSuccess: (r) => { setValidation(r); setValError(null); },
    onError: (e: Error) => { setValError(e.message); setValidation(null); },
  });

  const createMut = useMutation({
    mutationFn: async () => {
      const created = await apiSend<{ id: string }>('POST', '/training-datasets', {
        name,
        dataset_type_id: typeId,
        task_type: taskType,
        origin,
        ...(origin === 'REGISTERED' ? { relative_path: relPath } : {}),
      }, csrfToken);

      if (origin === 'BUILT') {
        await apiSend('POST', `/training-datasets/${created.id}/build-config`, {
          source_dataset_ids: sourceIds,
          storage_mode: 'COPY',
          split: strategy === 'RANDOM'
            ? { strategy: 'RANDOM', train_ratio: train, val_ratio: val, test_ratio: test, random_seed: seed }
            : { strategy: 'SAME' },
          ...(strategy === 'SAME'
            ? { same_split_warning_acknowledged: true, same_split_targets: targets }
            : {}),
        }, csrfToken);
      }

      await apiSend('POST', `/training-datasets/${created.id}/submit`, undefined, csrfToken);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['training-datasets'] });
      onClose();
    },
    onError: (e: Error) => setSubmitError(e.message),
  });

  // This wizard renders its own overlay rather than using <Modal>, so it has to
  // reproduce Modal's Escape-to-close. Without it the overlay stays up and swallows
  // every click behind it. Ignored while submitting, and while the file browser is
  // open so Escape closes that first.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !createMut.isPending && !browsing) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, createMut.isPending, browsing]);

  const canAdvance = (): boolean => {
    const label = STEPS[step];
    if (label === 'Type & Origin') return !!typeId;
    if (label === 'Details') return nameValid && nameTaken === false && taskTypeAvailable(taskType);
    if (label === 'Sources') return sourceIds.length > 0;
    if (label === 'Classes') return validation?.compatible === true;
    if (label === 'Directory') return !!relPath;
    if (label === 'Split') return splitTouched && (strategy === 'RANDOM' ? ratiosValid : ack && targets.length > 0);
    return false;
  };

  const stepDone = (i: number): boolean => {
    const lbl = STEPS[i];
    if (lbl === 'Type & Origin') return !!typeId;
    if (lbl === 'Details') return nameValid && nameTaken === false && taskTypeAvailable(taskType);
    if (lbl === 'Sources') return sourceIds.length > 0;
    if (lbl === 'Classes') return validation?.compatible === true;
    if (lbl === 'Directory') return !!relPath;
    if (lbl === 'Split') return splitTouched && (strategy === 'RANDOM' ? ratiosValid : ack && targets.length > 0);
    return false;
  };

  // Strictly sequential: a later step is only reachable once every earlier step is
  // actually done. Going back is always allowed.
  const canGoTo = (i: number): boolean => {
    if (i <= step) return true;
    for (let j = 0; j < i; j++) if (!stepDone(j)) return false;
    return true;
  };

  const goNext = () => {
    if (STEPS[step] === 'Sources') {
      setValidation(null);
      setValError(null);
      setValidating(true);
      validateMut.mutate(sourceIds, { onSettled: () => setValidating(false) });
    }
    setStep((s) => Math.min(s + 1, lastStep));
  };

  const goBack = () => {
    if (STEPS[step] === 'Classes') { setValidation(null); setValError(null); }
    setStep((s) => Math.max(s - 1, 0));
  };

  const label = STEPS[step];
  const submitting = createMut.isPending;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card-wizard" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>New Training Dataset</h3>
          <button className="btn btn-ghost modal-close" onClick={onClose}>×</button>
        </div>

        <div className="wizard-steps">
          {STEPS.map((s, i) => (
            <button
              key={s}
              className={`wizard-step${i === step ? ' active' : ''}${stepDone(i) ? ' done' : ''}`}
              disabled={!canGoTo(i)}
              onClick={() => setStep(i)}
            >
              <span className="wizard-step-num">{stepDone(i) ? '✓' : i + 1}</span>
              <span>{s}</span>
            </button>
          ))}
        </div>

        {submitError && <div className="form-error">{submitError}</div>}
        {valError && <div className="form-error">{valError}</div>}

        <div className="wizard-body">
          {label !== 'Type & Origin' && !typeId && (
            <PrereqNotice message="Select a Dataset Type in the first step first — the following steps depend on it." onGoToStep={() => setStep(0)} />
          )}
          {label === 'Type & Origin' && (
            <>
              <p className="hint">Which dataset type does this belong to?</p>
              <div className="type-grid">
                {types?.map((t) => (
                  <div
                    key={t.id}
                    className={`type-card${typeId === t.id ? ' selected' : ''}`}
                    onClick={() => { setTypeId(t.id); setSourceIds([]); setRelPath(''); }}
                  >
                    <div className="type-card-name">{t.name}</div>
                  </div>
                ))}
              </div>

              <h4 className="dash-h">How is it produced?</h4>
              <div className="origin-grid">
                <div
                  className={`origin-card${origin === 'BUILT' ? ' selected' : ''}`}
                  onClick={() => { setOrigin('BUILT'); setStep(0); }}
                >
                  <div className="origin-card-name">Build from source datasets</div>
                  <p className="origin-card-desc">
                    Merge scanned source datasets, compute a train/val/test split and write data.yaml.
                  </p>
                </div>
                <div
                  className={`origin-card${origin === 'REGISTERED' ? ' selected' : ''}`}
                  onClick={() => { setOrigin('REGISTERED'); setStep(0); }}
                >
                  <div className="origin-card-name">Register an existing directory</div>
                  <p className="origin-card-desc">
                    Point at a YOLO directory that already has data.yaml and split folders. Validated, not rebuilt.
                  </p>
                </div>
              </div>
            </>
          )}

          {label === 'Details' && typeId && (
            <>
              <label className="field">
                <span>Name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. pallets-v3"
                  autoFocus
                />
                <span
                  className={name && !nameValid ? 'form-error' : nameTaken === true ? 'hint hint-error' : 'hint'}
                >
                  {nameTaken === true
                    ? 'This name is already used by another dataset of this type — pick another.'
                    : 'Letters, digits, underscore and hyphen only — it becomes the directory name on disk.'}
                </span>
              </label>

              <div className="field">
                <span>Task type</span>
                <div className="choice-row">
                  {(['OBB', 'DETECT'] as TaskType[]).map((t) => {
                    const available = taskTypeAvailable(t);
                    return (
                      <button
                        key={t}
                        className={`choice${taskType === t ? ' selected' : ''}`}
                        disabled={!available}
                        title={available ? undefined : `No READY ${t} source datasets under ${activeType?.name ?? 'this type'}`}
                        onClick={() => setTaskType(t)}
                      >
                        {t}
                        <span className="choice-sub">
                          {gateTaskTypes
                            ? `${readyByTask[t]} READY source dataset${readyByTask[t] === 1 ? '' : 's'}`
                            : t === 'OBB' ? 'oriented boxes (9 fields)' : 'axis-aligned boxes (5 fields)'}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {noSourcesAtAll && (
                  <div className="error-banner">
                    <strong>{activeType?.name}</strong> has no READY source datasets, so there is
                    nothing to build from. Register and scan one under Source Datasets first, or go
                    back and register an existing directory instead.
                  </div>
                )}
                {origin === 'REGISTERED' && (
                  <span className="hint">Validation samples a label file and rejects the dataset if the geometry disagrees.</span>
                )}
              </div>
            </>
          )}

          {label === 'Sources' && typeId && (
            <>
              <p className="hint">
                READY <strong>{taskType}</strong> source datasets under <strong>{activeType?.name}</strong>
                {' — '}{sourceIds.length} of {readySources.length} selected
              </p>
              <input
                type="text"
                className="folder-search-input"
                placeholder="Filter source datasets…"
                value={sourceSearch}
                onChange={(e) => setSourceSearch(e.target.value)}
              />
              {(() => {
                const pending = (sources ?? []).filter((s) => s.task_type === taskType && s.status === 'SCANNING').length;
                return pending > 0 ? (
                  <PrereqNotice message={`${pending} source dataset(s) still scanning — their classes aren't ready yet. Wait for scan to finish or refresh this list.`} />
                ) : null;
              })()}
              {readySources.length > 0 && (
                <div className="checklist-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={sourceIds.length === readySources.length}
                    onClick={() => { setSourceIds(readySources.map((s) => s.id)); setLastPicked(null); }}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={sourceIds.length === 0}
                    onClick={() => { setSourceIds([]); setLastPicked(null); }}
                  >
                    Clear
                  </button>
                  <span className="hint">Shift-click to select a range.</span>
                </div>
              )}
              <div className="checklist">
                {readySources.length === 0 && (
                  <EmptyState
                    size="small"
                    message={`No READY ${taskType} source datasets for this type. Register and scan one first, or go back and change the task type.`}
                  />
                )}
                {(() => {
                  const q = sourceSearch.trim().toLowerCase();
                  const visible = q
                    ? readySources
                        .map((s, i) => ({ s, i }))
                        .filter(({ s }) => (s.name + ' ' + (s.sub_path ?? '')).toLowerCase().includes(q))
                    : readySources.map((s, i) => ({ s, i }));
                  if (visible.length === 0) {
                    return <EmptyState size="small" message="No source datasets match the filter." />;
                  }
                  return visible.map(({ s, i }) => (
                    // mousedown records the modifier and fires before the checkbox's
                    // change event, so onChange can read it. Calling preventDefault on the
                    // input's click instead would desync the controlled checkbox: the DOM
                    // property never flips and React keeps rendering the previous value.
                    <label
                      key={s.id}
                      className="check-row"
                      onMouseDown={(e) => { shiftHeld.current = e.shiftKey; }}
                    >
                      <input
                        type="checkbox"
                        checked={sourceIds.includes(s.id)}
                        onKeyDown={(e) => { shiftHeld.current = e.shiftKey; }}
                        onChange={() => {
                          const shift = shiftHeld.current;
                          setSourceIds(pickSources(readySources, sourceIds, i, lastPicked, shift));
                          if (!shift) setLastPicked(i);
                        }}
                      />
                      <span>
                        {s.name}
                        <span className="check-sub">
                          {s.sub_path ?? s.relative_path}
                          {s.image_count !== null && s.image_count !== undefined
                            ? ` · ${Number(s.image_count)} images`
                            : ''}
                        </span>
                      </span>
                    </label>
                  ));
                })()}
              </div>
            </>
          )}

          {label === 'Classes' && typeId && (
            <>
              {validating && <p className="hint">Checking class compatibility…</p>}
              {validation && (
                <>
                  <div className={validation.compatible ? 'success-banner' : 'error-banner'}>
                    {validation.compatible
                      ? `Compatible — ${validation.merged_classes.length} classes across ${validation.source_count} sources, ${validation.total_image_count} images`
                      : 'Cannot merge — the same class index means different things in different sources'}
                  </div>

                  <div className="class-table-wrap">
                    <table className="class-table">
                      <thead>
                        <tr>
                          <th>Index</th>
                          <th>Class Name</th>
                          <th>Sources</th>
                        </tr>
                      </thead>
                      <tbody>
                        {validation.merged_classes.map((c) => {
                          const conflict = validation.conflicts.find((cf) => cf.class_index === c.class_index);
                          return (
                            <tr key={c.class_index} className={conflict ? 'conflict-row' : ''}>
                              <td>{c.class_index}</td>
                              <td>
                                {conflict ? (
                                  <span className="conflict-name">
                                    <del>{conflict.class_name_a}</del> vs <ins>{conflict.class_name_b}</ins>
                                  </span>
                                ) : c.class_name}
                              </td>
                              <td className="sources-cell">{c.present_in_sources.join(', ')}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {!validation.compatible && (
                    <p className="form-error">Go back and deselect the conflicting source before continuing.</p>
                  )}
                </>
              )}
            </>
          )}

          {label === 'Directory' && typeId && (
            <>
              <p className="hint">
                Pick the directory holding <code>data.yaml</code>, under the training-dataset root
                of <strong>{activeType?.name}</strong>.
              </p>
              <div className="path-picker">
                {relPath
                  ? <PathDisplay path={relPath} />
                  : <span className="hint">Nothing selected yet</span>}
                <button className="btn btn-sm" onClick={() => setBrowsing(true)}>Browse…</button>
              </div>
              {browsing && (
                <FileBrowser
                  datasetTypeId={typeId}
                  root="training"
                  mode="folder"
                  value={relPath || undefined}
                  onSelect={(_abs, rel) => setRelPath(rel)}
                  onClose={() => setBrowsing(false)}
                />
              )}
            </>
          )}

          {label === 'Split' && typeId && (
            <>
              {validation && (
                <div className="success-banner">
                  {validation.merged_classes.length} classes · {validation.source_count} sources · {validation.total_image_count} images
                </div>
              )}

              <div className="field">
                <span>Split strategy</span>
                <div className="choice-row">
                  <button
                    className={`choice${strategy === 'RANDOM' ? ' selected' : ''}`}
                    onClick={() => { setStrategy('RANDOM'); setAck(false); setSplitTouched(true); }}
                  >
                    Random split
                    <span className="choice-sub">shuffle with a fixed seed</span>
                  </button>
                  <button
                    className={`choice${strategy === 'SAME' ? ' selected' : ''}`}
                    onClick={() => { setStrategy('SAME'); setSplitTouched(true); }}
                  >
                    No split
                    <span className="choice-sub">put every image in each split you pick</span>
                  </button>
                </div>
              </div>

              {strategy === 'RANDOM' && (
                <>
                  <div className="field">
                    <span>Ratios</span>
                    <div className="choice-row">
                      {RATIO_PRESETS.map((p) => (
                        <button
                          key={p.label}
                          className={`choice choice-sm${ratios.join() === p.ratios.join() ? ' selected' : ''}`}
                          onClick={() => { setRatios(p.ratios); setSplitTouched(true); }}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>

                    <div className="ratio-bar" title={`train ${train} / val ${val} / test ${test}`}>
                      <div className="ratio-seg ratio-train" style={{ width: `${train * 100}%` }}>
                        {train > 0.08 && `train ${Math.round(train * 100)}%`}
                      </div>
                      <div className="ratio-seg ratio-val" style={{ width: `${val * 100}%` }}>
                        {val > 0.08 && `val ${Math.round(val * 100)}%`}
                      </div>
                      <div className="ratio-seg ratio-test" style={{ width: `${test * 100}%` }}>
                        {test > 0.08 && `test ${Math.round(test * 100)}%`}
                      </div>
                    </div>

                    <div className="ratio-inputs">
                      {(['Train', 'Val', 'Test'] as const).map((lbl, i) => (
                        <label key={lbl} className="field field-inline">
                          <span>{lbl}</span>
                          <input
                            type="number"
                            step="0.05"
                            min="0"
                            max="1"
                            value={ratios[i]}
                            onChange={(e) => {
                              const next = [...ratios] as [number, number, number];
                              next[i] = Number(e.target.value);
                              setRatios(next);
                              setSplitTouched(true);
                            }}
                          />
                        </label>
                      ))}
                    </div>
                    {!ratiosValid && (
                      <span className="form-error">Ratios must sum to 1.00 with train &gt; 0 (currently {ratioSum.toFixed(2)}).</span>
                    )}
                  </div>

                  {ratiosValid && train < LOW_TRAIN_RATIO && (
                    <div className="warn-banner">
                      Only {Math.round(train * 100)}% of the images train the model. A training set
                      this small overfits easily — it can memorise those images and still score
                      poorly on anything new, while val and test hold data the model never learns
                      from. Prefer 70–90% for train unless you are deliberately testing behaviour
                      on a small sample.
                    </div>
                  )}

                  <label className="field field-inline">
                    <span>Random seed</span>
                    <input type="number" value={seed} onChange={(e) => { setSeed(Number(e.target.value)); setSplitTouched(true); }} />
                  </label>
                </>
              )}

              {strategy === 'SAME' && (
                <>
                  <div className="warn-banner">
                    No images are held back: every image is copied into <strong>every</strong> split
                    selected below. Picking both train and val therefore makes them identical, so
                    validation scores measure memorisation, not generalisation. Use this only to put
                    everything in a single split, or deliberately to validate on the training data.
                  </div>
                  <label className="check-row">
                    <input type="checkbox" checked={ack} onChange={(e) => { setAck(e.target.checked); setSplitTouched(true); }} />
                    <span>I understand the data-leakage risk</span>
                  </label>
                  <div className="field">
                    <span>Target splits</span>
                    <div className="choice-row">
                      {['train', 'val', 'test'].map((t) => (
                        <button
                          key={t}
                          className={`choice choice-sm${targets.includes(t) ? ' selected' : ''}`}
                          onClick={() => { setTargets(toggle(targets, t)); setSplitTouched(true); }}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={step === 0 ? onClose : goBack}>
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          {step < lastStep ? (
            <button className="btn btn-primary" disabled={!canAdvance() || validating} onClick={goNext}>
              Next
            </button>
          ) : (
            <button
              className="btn btn-primary"
              disabled={!canAdvance() || submitting}
              onClick={() => { setSubmitError(null); createMut.mutate(); }}
            >
              {submitting
                ? (origin === 'BUILT' ? 'Building…' : 'Validating…')
                : (origin === 'BUILT' ? 'Create & Build' : 'Register & Validate')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
