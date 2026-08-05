const GREEN = new Set(['READY', 'AVAILABLE', 'COMPLETED', 'ACTIVE', 'SUCCEEDED', 'ONLINE', 'IDLE']);
const AMBER = new Set([
  'SCANNING', 'BUILDING', 'RUNNING', 'PENDING', 'QUEUED', 'PREPARING',
  'REGISTERED', 'DRAFT', 'STOPPING', 'PARTIALLY_FAILED', 'BUSY', 'DRAINING', 'LOCKED',
  'VALIDATING',
]);
const RED = new Set(['INVALID', 'FAILED', 'STOPPED', 'CANCELLED', 'ERROR']);

function tone(status: string): 'green' | 'amber' | 'red' | 'grey' {
  const s = status.toUpperCase();
  if (GREEN.has(s)) return 'green';
  if (AMBER.has(s)) return 'amber';
  if (RED.has(s)) return 'red';
  return 'grey';
}

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="badge badge-grey">—</span>;
  return <span className={`badge badge-${tone(status)}`}>{status}</span>;
}
