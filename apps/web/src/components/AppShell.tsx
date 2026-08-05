import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '../stores/auth';
import { useUiStore, type Page } from '../stores/ui';
import { queryClient } from '../lib/queryClient';
import { apiGet } from '../lib/api';
import { ModelsPage } from '../pages/ModelsPage';
import { TrainingJobsPage } from '../pages/TrainingJobsPage';
import { BenchmarksPage } from '../pages/BenchmarksPage';
import { JobsPage } from '../pages/JobsPage';
import { NotificationsPage } from '../pages/NotificationsPage';
import { DashboardPage } from '../pages/DashboardPage';
import { AdminPage } from '../pages/AdminPage';
import { AccountPage } from '../pages/AccountPage';
import { DatasetsPage } from '../pages/DatasetsPage';

const NAV: { key: Page; label: string }[] = [
  { key: 'dashboard', label: 'Home' },
  { key: 'datasets', label: 'Datasets' },
  { key: 'models', label: 'Models' },
  { key: 'training', label: 'Training' },
  { key: 'benchmarks', label: 'Benchmarks' },
  { key: 'jobs', label: 'Jobs' },
  { key: 'notifications', label: 'Notifications' },
];

export function AppShell() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const rawPage = useUiStore((s) => s.page) as string;
  const setPage = useUiStore((s) => s.setPage);
  // Persisted pre-merge values ('source-datasets' / 'training-datasets') collapse onto the
  // single Datasets page; the sub-tab decides which half shows.
  const coercedPage = rawPage === 'source-datasets' || rawPage === 'training-datasets' ? 'datasets' : rawPage;
  // A persisted 'admin' page must not render for a non-admin (e.g. after switching users).
  const page: Page = coercedPage === 'admin' && user?.role !== 'ADMIN' ? 'dashboard' : (coercedPage as Page);

  // Real-time push: refresh notifications instantly when the server emits one (SSE),
  // instead of relying only on polling. EventSource sends the session cookie (same-origin)
  // and auto-reconnects.
  useEffect(() => {
    if (!user?.id) return;
    const es = new EventSource('/api/v1/events/stream');
    const onNotification = () => {
      queryClient.invalidateQueries({ queryKey: ['notif-unread'] });
      queryClient.invalidateQueries({ queryKey: ['notif-list'] });
    };
    // Job status changes (training/benchmark) → refresh the matching detail + list pages.
    const onJob = (e: MessageEvent) => {
      try {
        const d = JSON.parse(e.data) as { kind?: string; id?: string };
        if (d.kind === 'training') {
          queryClient.invalidateQueries({ queryKey: ['training-job', d.id] });
          queryClient.invalidateQueries({ queryKey: ['training-jobs'] });
        } else if (d.kind === 'benchmark') {
          queryClient.invalidateQueries({ queryKey: ['benchmark-run', d.id] });
          queryClient.invalidateQueries({ queryKey: ['benchmark-runs'] });
        }
        queryClient.invalidateQueries({ queryKey: ['jobs'] });
      } catch {
        /* ignore malformed */
      }
    };
    es.addEventListener('notification', onNotification);
    es.addEventListener('job', onJob);
    return () => {
      es.removeEventListener('notification', onNotification);
      es.removeEventListener('job', onJob);
      es.close();
    };
  }, [user?.id]);

  const nav = [...NAV, ...(user?.role === 'ADMIN' ? [{ key: 'admin' as Page, label: 'Admin' }] : [])];
  const [navOpen, setNavOpen] = useState(false);
  // Collapse the mobile nav dropdown whenever the page changes (link click, back button, etc.)
  useEffect(() => setNavOpen(false), [page]);

  const { data: unreadData } = useQuery({
    queryKey: ['notif-unread'],
    queryFn: () => apiGet<{ unread: number }>('/notifications/unread-count'),
    refetchInterval: 20000,
    enabled: !!user?.id,
  });
  const unread = unreadData?.unread ?? 0;

  const { data: storageStatus } = useQuery({
    queryKey: ['storage-status'],
    queryFn: () => apiGet<{ used_bytes: number; limit_bytes: number; warning_threshold_percent: number; used_percent: number; is_warning: boolean; is_exceeded: boolean }>('/storage/status'),
    refetchInterval: 30000,
    enabled: !!user?.id,
  });

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand" onClick={() => setPage('dashboard')} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
          <img src="/ikg-logo.svg" alt="" className="brand-logo" />
          <span><span className="brand-accent">IKG</span> Studio</span>
        </div>
        <button
          className="nav-toggle"
          onClick={() => setNavOpen((v) => !v)}
          aria-label="Toggle navigation"
          aria-expanded={navOpen}
        >
          ☰
        </button>
        <nav className={`nav${navOpen ? ' nav-open' : ''}`}>
          {nav.map((n) => (
            <button
              key={n.key}
              className={`nav-btn${page === n.key ? ' active' : ''}`}
              onClick={() => setPage(n.key)}
            >
              {n.label}
              {n.key === 'notifications' && unread > 0 && (
                <span className="nav-badge">{unread > 99 ? '99+' : unread}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <div className="topbar-user">
          <div className="user-area">
            <span className="user-role">{user?.role}</span>
            <button
              className={`user-btn${page === 'account' ? ' active' : ''}`}
              onClick={() => setPage('account')}
              title="Account & security"
            >
              {user?.display_name || user?.username}
            </button>
          </div>
          <button className="btn btn-ghost" onClick={() => void logout()}>
            Sign Out
          </button>
        </div>
      </header>
      {storageStatus?.is_exceeded && (
        <div className="error-banner" style={{ margin: '12px 24px 0', border: '1px solid var(--danger)' }}>
          <strong>Storage Limit Exceeded (100% used)</strong>
          <div>MinIO storage quota limit reached ({storageStatus.used_percent}% used). Uploads and executions write-blocked.</div>
        </div>
      )}
      {!storageStatus?.is_exceeded && storageStatus?.is_warning && (
        <div className="warn-banner" style={{ margin: '12px 24px 0', border: '1px solid var(--warning, #f39c12)' }}>
          <strong>Storage Usage Warning</strong>
          <div>MinIO storage usage at {storageStatus.used_percent}% (threshold: {storageStatus.warning_threshold_percent}%). Please clean up unused artifacts/models.</div>
        </div>
      )}
      <main className="content">
        {page === 'dashboard' && <DashboardPage />}
        {page === 'datasets' && <DatasetsPage />}
        {page === 'models' && <ModelsPage />}
        {page === 'training' && <TrainingJobsPage />}
        {page === 'benchmarks' && <BenchmarksPage />}
        {page === 'jobs' && <JobsPage />}
        {page === 'notifications' && <NotificationsPage />}
        {page === 'admin' && <AdminPage />}
        {page === 'account' && <AccountPage />}
      </main>
    </div>
  );
}
