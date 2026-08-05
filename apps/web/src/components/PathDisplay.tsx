import { useState } from 'react';

interface PathDisplayProps {
  path: string;
  maxLength?: number;
  className?: string;
}

export function PathDisplay({ path, maxLength = 40, className = '' }: PathDisplayProps) {
  const [copied, setCopied] = useState(false);

  if (!path) return <span className={`type-path ${className}`}>—</span>;

  const displayPath = path.length > maxLength ? `${path.slice(0, maxLength)}…` : path;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (non-secure context) — the full path is still in the title.
    }
  };

  return (
    <button
      type="button"
      className={`type-path type-path-copy ${className}`}
      data-copied={copied}
      onClick={copy}
      title={copied ? 'Copied!' : path}
      aria-label={`Copy path ${path}`}
    >
      <span aria-live="polite">{copied ? '✓ ' : ''}</span>
      {displayPath}
    </button>
  );
}
