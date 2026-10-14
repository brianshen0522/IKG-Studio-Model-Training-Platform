import { useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { useStopInferenceRun, useRetryInferenceRun, canStop, canRetry, stopLabel } from '../lib/inferenceActions';

/** Stop / Retry for one inference run, used on the run list and the run page. */
export function InferenceRunActions({ run }: { run: { id: string; name: string; status: string } }) {
  const stopMut = useStopInferenceRun();
  const retryMut = useRetryInferenceRun();
  const [confirm, setConfirm] = useState<'stop' | 'retry' | null>(null);

  if (!canStop(run.status) && !canRetry(run.status)) return null;

  const close = () => { setConfirm(null); stopMut.reset(); retryMut.reset(); };
  const busy = stopMut.isPending || retryMut.isPending;

  return (
    // Cards open the run on click; the buttons must not.
    <span style={{ display: 'inline-flex', gap: 8 }} onClick={(e) => e.stopPropagation()}>
      {canStop(run.status) && (
        <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => setConfirm('stop')}>
          {stopLabel(run.status)}
        </button>
      )}
      {canRetry(run.status) && (
        <button className="btn btn-sm btn-secondary" disabled={busy} onClick={() => setConfirm('retry')}>
          Retry
        </button>
      )}
      {confirm === 'stop' && (
        <ConfirmDialog
          title={run.status === 'RUNNING' ? 'Stop inference run' : 'Cancel inference run'}
          message={run.status === 'RUNNING'
            ? `Stop "${run.name}"? Datasets already finished keep their results; the one in progress stops within a few seconds and its partial results are kept for the compare page, without a ZIP.`
            : `Cancel "${run.name}" before it starts?`}
          // The dialog's dismiss button already reads "Cancel".
          confirmLabel={run.status === 'RUNNING' ? 'Stop run' : 'Cancel run'}
          danger
          error={stopMut.error ? (stopMut.error as Error).message : null}
          confirmDisabled={stopMut.isPending}
          onCancel={close}
          onConfirm={() => stopMut.mutate(run.id, { onSuccess: close })}
        />
      )}
      {confirm === 'retry' && (
        <ConfirmDialog
          title="Retry inference run"
          message={`Run the datasets of "${run.name}" that did not complete again?\n\nDatasets that completed keep their results and ZIP. For the others, the previous attempt's results are cleared and they are inferred from the start against the source as it is now.`}
          confirmLabel="Retry"
          error={retryMut.error ? (retryMut.error as Error).message : null}
          confirmDisabled={retryMut.isPending}
          onCancel={close}
          onConfirm={() => retryMut.mutate(run.id, { onSuccess: close })}
        />
      )}
    </span>
  );
}
