import { Modal } from './Modal';

interface ConfirmDialogProps {
  title?: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  /** Server-side failure to show in place, so the dialog can stay open for a retry. */
  error?: string | null;
  /** Greys out the confirm button — for preconditions known before the request. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title = 'Confirm', message, confirmLabel = 'Confirm', danger,
  error, confirmDisabled, onConfirm, onCancel,
}: ConfirmDialogProps) {
  // Blocks separated by a blank line render as distinct paragraphs; the first is the
  // primary warning, any further block (e.g. "used by N job(s)...") is secondary
  // context and gets a quieter, boxed treatment so it doesn't compete for attention.
  const [primary, ...rest] = message.split('\n\n').filter(Boolean);

  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn btn-sm btn-ghost" onClick={onCancel}>Cancel</button>
          <button
            className={`btn btn-sm ${danger ? 'btn-danger' : ''}`}
            onClick={onConfirm}
            disabled={confirmDisabled}
            autoFocus
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className={`confirm-dialog${danger ? ' confirm-dialog-danger' : ''}`}>
        {danger && <span className="confirm-dialog-icon" aria-hidden="true">!</span>}
        <div className="confirm-dialog-text">
          <p className="confirm-dialog-primary">{primary}</p>
          {rest.map((block, i) => (
            <p className="confirm-dialog-context" key={i}>{block}</p>
          ))}
          {error && <p className="form-error">{error}</p>}
        </div>
      </div>
    </Modal>
  );
}
