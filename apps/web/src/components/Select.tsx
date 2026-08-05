import { useEffect, useRef, useState } from 'react';

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  minWidth?: number;
}

/** Styled stand-in for a native <select>, matching the app's dark surface/border
 * tokens instead of the browser's OS-themed popup. Closes on outside click and Escape. */
export function Select({ value, options, onChange, placeholder = 'Select…', minWidth = 160 }: SelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div className="select-root" ref={rootRef} style={{ minWidth }}>
      <button
        type="button"
        className={`select-trigger${open ? ' is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{current?.label ?? placeholder}</span>
        <span className="select-caret">▾</span>
      </button>
      {open && (
        <div className="select-menu">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`select-option${o.value === value ? ' is-selected' : ''}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
