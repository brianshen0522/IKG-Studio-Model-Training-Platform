import { useState, useRef, useEffect, useMemo } from 'react';

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
}

interface Props {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  searchable?: boolean;
  style?: React.CSSProperties;
}

export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = 'All',
  label,
  searchable = false,
  style,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    if (!query) return options;
    const q = query.toLowerCase();
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || o.hint?.toLowerCase().includes(q),
    );
  }, [options, query]);

  return (
    <div ref={ref} style={{ position: 'relative', ...style }}>
      {label && (
        <label style={{ fontSize: '12px', color: 'var(--text-sub)', whiteSpace: 'nowrap', display: 'block', marginBottom: '2px' }}>
          {label}
        </label>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          width: '100%',
          padding: '7px 12px',
          fontSize: '13px',
          background: 'var(--bg)',
          color: 'var(--text)',
          border: open ? '1px solid var(--primary)' : '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          cursor: 'pointer',
          transition: 'border-color 0.15s ease',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textAlign: 'left' }}>
          {selected ? selected.label : placeholder}
        </span>
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none" style={{ opacity: 0.6, flexShrink: 0 }}>
          <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            minWidth: '200px',
            zIndex: 200,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            boxShadow: 'var(--shadow)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {searchable && (
            <div style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>
              <input
                type="text"
                placeholder="Search..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
                style={{
                  width: '100%',
                  padding: '6px 10px',
                  fontSize: '13px',
                  background: 'var(--bg)',
                  color: 'var(--text)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                }}
              />
            </div>
          )}

          <div style={{ maxHeight: '240px', overflowY: 'auto' }}>
            {/* Clear / All option */}
            <button
              type="button"
              onClick={() => {
                onChange('');
                setOpen(false);
                setQuery('');
              }}
              style={{
                display: 'flex',
                flexDirection: 'column',
                width: '100%',
                padding: '8px 12px',
                background: !value ? 'var(--blue-glow)' : 'transparent',
                color: 'var(--text)',
                border: 'none',
                borderBottom: '1px solid var(--border)',
                cursor: 'pointer',
                textAlign: 'left',
                fontSize: '13px',
                fontWeight: !value ? 600 : 400,
              }}
            >
              {placeholder}
            </button>

            {filtered.length === 0 ? (
              <div style={{ padding: '12px', textAlign: 'center', color: 'var(--text-sub)', fontSize: '13px' }}>
                No matches found
              </div>
            ) : (
              filtered.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                    setQuery('');
                  }}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    width: '100%',
                    padding: '8px 12px',
                    background: value === opt.value ? 'var(--blue-glow)' : 'transparent',
                    color: 'var(--text)',
                    border: 'none',
                    borderBottom: '1px solid var(--border)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontSize: '13px',
                    fontWeight: value === opt.value ? 600 : 400,
                  }}
                >
                  <span>{opt.label}</span>
                  {opt.hint && <span style={{ fontSize: '11px', color: 'var(--text-sub)' }}>{opt.hint}</span>}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
