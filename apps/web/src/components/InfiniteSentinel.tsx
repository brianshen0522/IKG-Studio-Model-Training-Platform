import { useEffect, useRef } from 'react';

interface InfiniteSentinelProps {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}

/**
 * Sentinel at the end of an infinite list. As it scrolls into view it asks for the
 * next page; `hasNextPage` false hides it entirely. Observing is (re)wired only when
 * the fetch state changes, so a page load that completes without moving the scroll
 * position still picks up the next page on the next re-observe.
 */
export function InfiniteSentinel({ hasNextPage, isFetchingNextPage, onLoadMore }: InfiniteSentinelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  useEffect(() => {
    const el = ref.current;
    if (!el || !hasNextPage || isFetchingNextPage) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) onLoadMoreRef.current(); },
      { rootMargin: '400px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage]);

  if (!hasNextPage) return null;

  return (
    <div ref={ref} className="infinite-sentinel" aria-hidden>
      {isFetchingNextPage && <span className="hint">Loading more…</span>}
    </div>
  );
}
