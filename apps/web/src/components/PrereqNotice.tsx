export function PrereqNotice({ message, onGoToStep }: { message: string; onGoToStep?: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '14px 16px',
        border: '1px dashed var(--border)',
        borderRadius: 'var(--radius)',
        background: 'var(--surface-muted)',
        fontSize: '13px',
        color: 'var(--text-sub)',
      }}
    >
      <span>{message}</span>
      {onGoToStep && (
        <button className="btn btn-sm btn-secondary" onClick={onGoToStep} type="button">
          Go to Step 1
        </button>
      )}
    </div>
  );
}
