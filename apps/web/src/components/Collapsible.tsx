import { useState, type ReactNode } from 'react';

/**
 * A titled section that starts closed.
 *
 * Used for reference detail — a full hyperparameter dump, for instance — that belongs on
 * the page but is not what the page is opened to read.
 */
export function Collapsible({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`collapsible${open ? ' is-open' : ''}`}>
      <button className="collapsible-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="collapsible-caret" aria-hidden>▸</span>
        <span className="collapsible-title">{title}</span>
        {count !== undefined && <span className="collapsible-count">{count}</span>}
      </button>
      {open && <div className="collapsible-body">{children}</div>}
    </div>
  );
}
