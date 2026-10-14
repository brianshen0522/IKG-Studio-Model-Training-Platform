import { useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { useAuthStore } from '../stores/auth';
import {
  useStopInferenceRun, useRetryInferenceRun, useDeleteInferenceRun, canStop, canRetry, canDelete, stopLabel,
} from '../lib/inferenceActions';

interface RunLike {
  id: string;
  name: string;
  status: string;
  created_by_user_id: string;
  diff_image_count?: number;
}

/**
 * Stop / Retry / Delete for one inference run, used on the run list and the
 * run page. Delete is offered to admins and to whoever started the run, the
 * same rule the API enforces; `onDeleted` lets the run page leave itself.
 */
export function InferenceRunActions({ run, onDeleted }: { run: RunLike; onDeleted?: () => void }) {
  const user = useAuthStore((s) => s.user);
  const stopMut = useStopInferenceRun();
  const retryMut = useRetryInferenceRun();
  const deleteMut = useDeleteInferenceRun();
  const [confirm, setConfirm] = useState<'stop' | 'retry' | 'delete' | null>(null);

  const mayDelete = canDelete(run.status) && (user?.role === 'ADMIN' || user?.id === run.created_by_user_id);
  if (!canStop(run.status) && !canRetry(run.status) && !mayDelete) return null;

  const close = () => { setConfirm(null); stopMut.reset(); retryMut.reset(); deleteMut.reset(); };
  const busy = stopMut.isPending || retryMut.isPending || deleteMut.isPending;
  const diffs = run.diff_image_count ?? 0;

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
      {mayDelete && (
        <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} disabled={busy} onClick={() => setConfirm('delete')}>
          Delete
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
      {confirm === 'delete' && (
        <ConfirmDialog
          title="Delete inference run"
          message={`Delete "${run.name}"? This cannot be undone.\n\n${diffs > 0 ? `The comparison results for ${diffs.toLocaleString()} differing image${diffs === 1 ? '' : 's'} and the run's ZIP downloads are removed and their space freed. ` : ''}The source datasets are not touched, and the name can be used again for a new run.`}
          confirmLabel="Delete run"
          danger
          error={deleteMut.error ? (deleteMut.error as Error).message : null}
          confirmDisabled={deleteMut.isPending}
          onCancel={close}
          onConfirm={() => deleteMut.mutate(run.id, { onSuccess: () => { close(); onDeleted?.(); } })}
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
