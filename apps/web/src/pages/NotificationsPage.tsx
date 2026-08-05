import { useState } from 'react';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { apiGetList, apiSend } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { useAuthStore } from '../stores/auth';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { EmptyState } from '../components/EmptyState';
import { InfiniteSentinel } from '../components/InfiniteSentinel';
import { Select } from '../components/Select';
import { formatDate } from '../lib/format';

interface NotificationItem {
  id: string;
  severity: string;
  title: string;
  message: string;
  resource_type_code: string | null;
  resource_id: string | null;
  created_at: string;
  read_at: string | null;
}

const SEV: Record<string, { color: string; icon: string }> = {
  SUCCESS: { color: 'var(--green)', icon: '✓' },
  WARNING: { color: 'var(--yellow)', icon: '!' },
  ERROR: { color: 'var(--red)', icon: '✕' },
};

const SEV_OPTIONS = [
  { value: '', label: 'All severities' },
  { value: 'SUCCESS', label: 'Success' },
  { value: 'WARNING', label: 'Warning' },
  { value: 'ERROR', label: 'Error' },
];

export function NotificationsPage() {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [severity, setSeverity] = useState('');

  const params = new URLSearchParams({ size: '30' });
  if (unreadOnly) params.set('unread', 'true');
  if (severity) params.set('severity', severity);

  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['notifications', unreadOnly, severity],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(params);
      p.set('page', String(pageParam));
      return apiGetList<NotificationItem>(`/notifications?${p}`);
    },
    initialPageParam: 1,
    getNextPageParam: (last) => (last.meta.page < last.meta.totalPages ? last.meta.page + 1 : undefined),
  });

  const markRead = useMutation({
    mutationFn: (id: string) => apiSend('POST', `/notifications/${id}/read`, undefined, csrfToken),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['notif-unread'] });
      queryClient.invalidateQueries({ queryKey: ['notif-list'] });
    },
  });

  const markAll = useMutation({
    mutationFn: () => apiSend('POST', '/notifications/read-all', undefined, csrfToken),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['notif-unread'] });
      queryClient.invalidateQueries({ queryKey: ['notif-list'] });
    },
  });

  const items = data?.pages.flatMap((p) => p.data) ?? [];
  const total = data?.pages[0]?.meta.total;

  const filtersActive = unreadOnly || severity !== '';
  const resetFilters = () => { setUnreadOnly(false); setSeverity(''); };

  return (
    <section className="page">
      <header className="page-head">
        <h2>Notifications</h2>
        <div className="spacer" />
        <span className="cell-sub">{total ?? '…'} total</span>
        <button
          className="btn btn-sm"
          disabled={markAll.isPending}
          onClick={() => markAll.mutate()}
          style={{ marginLeft: 8 }}
        >
          Mark all read
        </button>
      </header>

      <div className="filters">
        <label className="check-row" style={{ gap: 6 }}>
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(e) => setUnreadOnly(e.target.checked)}
          />
          <span>Unread only</span>
        </label>
        <Select
          value={severity}
          onChange={(v) => setSeverity(v)}
          options={SEV_OPTIONS}
          minWidth={150}
        />
        {filtersActive && (
          <button className="btn btn-sm btn-ghost" onClick={resetFilters}>
            Reset filters
          </button>
        )}
      </div>

      {isLoading && <SkeletonLoader rows={6} variant="list" />}
      {error && <EmptyState type="error" message={(error as Error).message} />}

      {!isLoading && !error && items.length === 0 && (
        <EmptyState message="No notifications found." />
      )}

      {items.length > 0 && (
        <>
        <div className="notif-list">
          {items.map((n) => {
            const sev = SEV[n.severity] ?? { color: 'var(--text-sub)', icon: '•' };
            const unread = !n.read_at;
            return (
              <div
                key={n.id}
                className={`notif-card ${unread ? 'is-unread' : 'is-read'}`}
                style={{ '--sev-color': sev.color } as React.CSSProperties}
              >
                <span className="notif-icon">{sev.icon}</span>
                <div className="notif-body">
                  <div className="notif-head-row">
                    {unread && <span className="notif-dot" />}
                    <span className="notif-title">{n.title}</span>
                  </div>
                  <div className="notif-message">{n.message}</div>
                </div>
                <div className="notif-meta">
                  <span className="notif-date">{formatDate(n.created_at)}</span>
                  {unread && (
                    <button
                      className="btn btn-sm"
                      disabled={markRead.isPending}
                      onClick={() => markRead.mutate(n.id)}
                    >
                      Mark read
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <InfiniteSentinel
          hasNextPage={hasNextPage === true}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={() => fetchNextPage()}
        />
        </>
      )}
    </section>
  );
}
