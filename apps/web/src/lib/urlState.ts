import { useCallback, useEffect, useState } from 'react';

/**
 * Syncs a single detail-view id with a URL query param so a page reload
 * (or browser back/forward) doesn't drop the user back to the list view.
 * Uses pushState directly instead of react-router — one param, one hook,
 * doesn't warrant a router dependency for this app's tab-based nav.
 */
export function useUrlParam(key: string): [string | null, (value: string | null) => void] {
  const read = useCallback(
    () => new URLSearchParams(window.location.search).get(key),
    [key],
  );
  const [value, setValueState] = useState<string | null>(read);

  useEffect(() => {
    const onPop = () => setValueState(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [read]);

  const setValue = useCallback(
    (next: string | null) => {
      const params = new URLSearchParams(window.location.search);
      if (next === null) params.delete(key);
      else params.set(key, next);
      const search = params.toString();
      const url = `${window.location.pathname}${search ? `?${search}` : ''}`;
      window.history.pushState(null, '', url);
      setValueState(next);
    },
    [key],
  );

  return [value, setValue];
}
