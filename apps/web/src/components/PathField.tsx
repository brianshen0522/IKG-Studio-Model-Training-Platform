import { useEffect, useRef, useState } from 'react';
import { apiGet } from '../lib/api';
import {
  checkPathFormat, isPathBad, isPathOk, pathStatusMessage,
  type PathStatus,
} from '../lib/path';
import { PathBrowser } from './PathBrowser';

interface ValidateResponse {
  status: 'ok' | 'missing' | 'not_a_directory' | 'outside_root';
  basePath: string;
}

/**
 * Absolute-path input with a Browse picker and a live status check, modelled on Dataset
 * Manager's dataset-type form.
 *
 * The picker can only yield real directories, but the field beside it is free text, so a
 * typed path is checked the same way: format first (locally, no request), then the
 * filesystem (one request, on blur / Enter / after picking). Status drives the border
 * colour and the hint line, and the parent gates submit on it.
 */
export function PathField({
  label, value, onChange, hint, placeholder, browserTitle,
  required = false, collision = null, status, onStatusChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint: string;
  placeholder?: string;
  browserTitle: string;
  required?: boolean;
  /** Message shown instead of the status when this path duplicates another field. */
  collision?: string | null;
  status: PathStatus;
  onStatusChange: (s: PathStatus) => void;
}) {
  const [browsing, setBrowsing] = useState(false);
  // Guards against a slow response for an old value overwriting a newer check.
  const seq = useRef(0);

  async function check(raw: string) {
    const mine = ++seq.current;
    const trimmedEmpty = raw.trim() === '';
    if (trimmedEmpty && !required) { onStatusChange({ kind: 'idle' }); return; }

    const formatError = checkPathFormat(raw);
    if (formatError) {
      // Rejected without a request — this is why format lives on the client.
      onStatusChange({ kind: 'format', error: formatError });
      return;
    }

    onStatusChange({ kind: 'checking' });
    try {
      const r = await apiGet<ValidateResponse>(`/admin/browse/validate?path=${encodeURIComponent(raw)}`);
      if (mine !== seq.current) return;
      onStatusChange(r.status === 'outside_root'
        ? { kind: 'outside_root', basePath: r.basePath }
        : { kind: r.status });
    } catch {
      if (mine !== seq.current) return;
      onStatusChange({ kind: 'unreachable' });
    }
  }

  // Validate a prefilled value (edit mode) once on mount, so an existing type whose root
  // has since been moved or deleted shows as broken rather than silently fine.
  const checkedInitial = useRef(false);
  useEffect(() => {
    if (checkedInitial.current) return;
    checkedInitial.current = true;
    if (value.trim() !== '') void check(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bad = collision !== null || isPathBad(status);
  const good = collision === null && isPathOk(status);
  const message = collision ?? pathStatusMessage(status);

  return (
    <>
    <label className="field">
      <span>{label}</span>
      <div className="path-row">
        <input
          className={bad ? 'is-invalid' : good ? 'is-valid' : undefined}
          value={value}
          // Typing invalidates the previous verdict; re-checking on every keystroke
          // would mean a request per character.
          onChange={(e) => { onChange(e.target.value); onStatusChange({ kind: 'idle' }); }}
          onBlur={() => void check(value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void check(value); } }}
          placeholder={placeholder}
        />
        <button type="button" className="btn btn-sm" onClick={() => setBrowsing(true)}>
          Browse
        </button>
      </div>
      {status.kind === 'checking' && collision === null ? (
        <span className="hint hint-checking">Checking…</span>
      ) : message ? (
        <span className="hint hint-error">{message}</span>
      ) : good ? (
        <span className="hint hint-ok">Directory exists.</span>
      ) : (
        <span className="hint">{hint}</span>
      )}
    </label>
    {/* Outside the <label> on purpose. Nested, the `.field input` rule (width: 100%)
        would also style the browser's filter box, and clicking anywhere in the browser
        would focus the label's input. */}
    {browsing && (
      <PathBrowser
        mode="folder"
        title={browserTitle}
        onSelect={(p) => { onChange(p); void check(p); }}
        onClose={() => setBrowsing(false)}
      />
    )}
    </>
  );
}
