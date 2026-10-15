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

/** Time between two Postgres timestamps, as "45s", "3m 12s" or "2h 05m". Open-ended
 * (no end) measures to now, for something still running. */
export function formatElapsed(start: string | null | undefined, end?: string | null): string {
  if (!start) return '—';
  const from = new Date(toParsableIso(start)).getTime();
  const to = end ? new Date(toParsableIso(end)).getTime() : Date.now();
  if (Number.isNaN(from) || Number.isNaN(to)) return '—';
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Share of a whole as "37%", or "<1%" for a non-zero share that rounds to 0. */
export function formatShare(part: number, whole: number): string {
  if (!whole) return '—';
  const p = (part / whole) * 100;
  if (part > 0 && p < 1) return '<1%';
  return `${Math.round(p)}%`;
}
