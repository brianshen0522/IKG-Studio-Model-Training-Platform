interface EmptyStateProps {
  type?: 'empty' | 'loading' | 'error';
  message?: string;
  size?: 'large' | 'small';
}

export function EmptyState({
  type = 'empty',
  message = 'No data',
  size = 'large'
}: EmptyStateProps) {
  const stateClass = size === 'large' ? 'state' : 'state state-sm';
  const stateTypeClass = type === 'error' ? `${stateClass} state-error` : stateClass;
  
  return <div className={stateTypeClass}>{message}</div>;
}
