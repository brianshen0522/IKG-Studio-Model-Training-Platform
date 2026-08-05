import { useState } from 'react';

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // The Clipboard API needs a secure context and this is served over plain http on
      // the office network. The fallback keeps the button honest rather than having it
      // silently do nothing.
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <button className={`btn btn-sm${copied ? ' btn-ok' : ''}`} onClick={copy}>
      {copied ? '✓ Copied' : label}
    </button>
  );
}
