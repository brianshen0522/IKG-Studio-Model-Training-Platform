export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(Number(bytes))) return '—';
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

/** Postgres returns e.g. "2026-07-30 01:34:36.692848+00" (space separator, 6-digit
 * fraction, colonless offset) which `new Date()` cannot parse directly. Normalize to
 * a strict ISO-8601 string first. Any code doing `new Date(pgTimestamp)` must go
 * through this first. */
export function toParsableIso(raw: string): string {
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}(?::?\d{2})?)?$/);
  if (!m) return raw;
  const [, date, rawTime, rawOffset] = m;
  const time = rawTime.replace(/(\.\d{3})\d+$/, '$1');
  const offset = !rawOffset || rawOffset === 'Z' ? 'Z' : rawOffset.includes(':') ? rawOffset : `${rawOffset}:00`;
  return `${date}T${time}${offset}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(toParsableIso(iso));
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
