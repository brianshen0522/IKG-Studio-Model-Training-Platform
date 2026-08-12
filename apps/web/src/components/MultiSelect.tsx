import { useEffect, useRef, useState } from 'react';

export interface MultiSelectOption {
  value: string;
  label: string;
}

interface MultiSelectProps {
  value: string[];
  options: MultiSelectOption[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  minWidth?: number;
}

/** Multi-select dropdown — same look as <Select> but options toggle via checkbox. */
export function MultiSelect({ value, options, onChange, placeholder = 'Filter…', minWidth = 160 }: MultiSelectProps) {
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

  const toggle = (v: string) =>
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);

  const label = value.length === 0 ? placeholder : `${value.length} selected`;

  return (
    <div className="select-root" ref={rootRef} style={{ minWidth }}>
      <button
        type="button"
        className={`select-trigger${open ? ' is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{label}</span>
        <span className="select-caret">▾</span>
      </button>
      {open && (
        <div className="select-menu">
          {options.map((o) => {
            const checked = value.includes(o.value);
            return (
              <label key={o.value} className={`select-option select-option-check${checked ? ' is-selected' : ''}`}>
                <input type="checkbox" checked={checked} onChange={() => toggle(o.value)} />
                <span>{o.label}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
