import type { ReactNode } from 'react';
import { useUiStore } from '../stores/ui';

interface CollapsibleTypeGroupProps {
  /** Header content (type dot, name, path, count) — rendered before the spacer. */
  head: ReactNode;
  children: ReactNode;
  className?: string;
  collapsed: boolean;
  onToggle: () => void;
}

/**
 * A dataset-type section on the list pages (Models / Source & Training Datasets).
 * Fully controlled by the page so a single master toggle can expand/collapse every
 * group at once; per-group buttons keep working independently.
 */
export function CollapsibleTypeGroup({ head, children, className = 'type-group', collapsed, onToggle }: CollapsibleTypeGroupProps) {
  return (
    <section className={className}>
      <div className="type-group-head">
        {head}
        <div className="spacer" />
        <button type="button" className="btn btn-sm btn-ghost" onClick={onToggle} aria-expanded={!collapsed}>
          {collapsed ? '▸ Expand' : '▾ Collapse'}
        </button>
      </div>
      {!collapsed && <div className="type-group-body">{children}</div>}
    </section>
  );
}

/**
 * Shared per-page collapse state for type groups, persisted to the UI store so a
 * reload keeps each group's expand/collapse choice. Keys are namespaced per page;
 * missing keys default to collapsed. `toggleAll` collapses every group when all are
 * expanded and expands them otherwise.
 */
export function useTypeGroupCollapse(page: string, keys: string[]) {
  const collapsedByKey = useUiStore((s) => s.groupCollapsed);
  const setGroupCollapsed = useUiStore((s) => s.setGroupCollapsed);
  const storeKey = (k: string) => `${page}::${k}`;
  const isCollapsed = (k: string) => collapsedByKey[storeKey(k)] !== false;
  const anyCollapsed = keys.some((k) => isCollapsed(k));
  const toggleGroup = (k: string) => setGroupCollapsed({ [storeKey(k)]: !isCollapsed(k) });
  const toggleAll = () => {
    const collapse = !anyCollapsed;
    setGroupCollapsed(Object.fromEntries(keys.map((k) => [storeKey(k), collapse])));
  };
  return { isCollapsed, toggleGroup, toggleAll, anyCollapsed };
}
