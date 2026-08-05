import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiGetList, apiSend } from '../../lib/api';
import { StatusBadge } from '../../components/StatusBadge';
import { SkeletonLoader } from '../../components/SkeletonLoader';
import { EmptyState } from '../../components/EmptyState';
import { formatDate } from '../../lib/format';
import { queryClient } from '../../lib/queryClient';
import { useAuthStore } from '../../stores/auth';
import { NewUserDialog } from '../../components/NewUserDialog';
import { Modal } from '../../components/Modal';

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  role: string;
  status: string;
  created_at: string;
  row_version: number;
}

export function UsersAdmin() {
  const [showNew, setShowNew] = useState(false);
  const [resetTarget, setResetTarget] = useState<{ id: string; username: string } | null>(null);
  const csrfToken = useAuthStore((s) => s.csrfToken);
  const currentUserId = useAuthStore((s) => s.user?.id);

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => apiGetList<UserRow>('/admin/users?size=100'),
  });

  const action = useMutation({
    mutationFn: ({ id, verb }: { id: string; verb: string }) =>
      apiSend('POST', `/admin/users/${id}/${verb}`, undefined, csrfToken),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
  });

  const roleMutation = useMutation({
    mutationFn: ({ id, role, row_version }: { id: string; role: string; row_version: number }) =>
      apiSend('PATCH', `/admin/users/${id}`, { role, row_version }, csrfToken),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
  });

  return (
    <section className="page">
      <header className="page-head">
        <h2>Users</h2>
        <div className="spacer" />
        <button className="btn btn-sm" onClick={() => setShowNew(true)}>
          New User
        </button>
      </header>

      {isLoading && <SkeletonLoader rows={5} cols={6} />}
      {error && <EmptyState type="error" message={(error as Error).message} />}
      {data && data.data.length === 0 && <EmptyState message="No users yet." />}

      {data && data.data.length > 0 && (
        <div className="user-list">
          {data.data.map((u) => (
            <div className="user-card" key={u.id}>
              <span className="user-avatar">{u.username[0]?.toUpperCase() ?? '?'}</span>
              <div className="user-body">
                <div className="user-head-row">
                  <span className="user-name">{u.username}</span>
                  <span className={`badge ${u.role === 'ADMIN' ? 'badge-blue' : 'badge-grey'}`}>{u.role}</span>
                </div>
                <div className="user-sub">
                  {u.display_name}
                  {u.email ? ` · ${u.email}` : ''}
                </div>
              </div>
              <div className="user-meta">
                <StatusBadge status={u.status} />
                <span className="user-date">{formatDate(u.created_at)}</span>
                <div className="actions">
                  {u.status === 'ACTIVE' && (
                    <button
                      className="btn btn-sm"
                      disabled={action.isPending}
                      onClick={() => action.mutate({ id: u.id, verb: 'disable' })}
                    >
                      Disable
                    </button>
                  )}
                  {u.status === 'DISABLED' && (
                    <button
                      className="btn btn-sm"
                      disabled={action.isPending}
                      onClick={() => action.mutate({ id: u.id, verb: 'enable' })}
                    >
                      Enable
                    </button>
                  )}
                  {u.status === 'LOCKED' && (
                    <button
                      className="btn btn-sm"
                      disabled={action.isPending}
                      onClick={() => action.mutate({ id: u.id, verb: 'unlock' })}
                    >
                      Unlock
                    </button>
                  )}
                  <button
                    className="btn btn-sm"
                    disabled={roleMutation.isPending || (u.role === 'ADMIN' && u.id === currentUserId)}
                    title={u.role === 'ADMIN' && u.id === currentUserId ? "Can't demote yourself" : undefined}
                    onClick={() =>
                      roleMutation.mutate({
                        id: u.id,
                        role: u.role === 'USER' ? 'ADMIN' : 'USER',
                        row_version: u.row_version,
                      })
                    }
                  >
                    {u.role === 'USER' ? 'Make Admin' : 'Make User'}
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => setResetTarget({ id: u.id, username: u.username })}
                  >
                    Reset Password
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showNew && <NewUserDialog onClose={() => setShowNew(false)} />}

      {resetTarget && (
        <SetPasswordDialog
          username={resetTarget.username}
          onClose={() => setResetTarget(null)}
          onSubmit={async (password) => {
            await apiSend('POST', `/admin/users/${resetTarget.id}/reset-password`, { new_password: password }, csrfToken);
            setResetTarget(null);
          }}
        />
      )}
    </section>
  );
}

function SetPasswordDialog({
  username,
  onClose,
  onSubmit,
}: {
  username: string;
  onClose: () => void;
  onSubmit: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const mismatch = confirm.length > 0 && password !== confirm;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await onSubmit(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set password.');
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      title={`Set password for ${username}`}
      onClose={onClose}
      footer={
        <button className="btn btn-primary" type="submit" form="set-pw-form" disabled={pending || !password || mismatch}>
          {pending ? 'Saving…' : 'Set password'}
        </button>
      }
    >
      <form id="set-pw-form" onSubmit={handleSubmit}>
        <label className="field">
          <span>New password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus autoComplete="new-password" />
        </label>
        <label className="field">
          <span>Confirm password</span>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </label>
        {mismatch && <div className="form-error">Passwords do not match.</div>}
        {error && <div className="form-error">{error}</div>}
      </form>
    </Modal>
  );
}
