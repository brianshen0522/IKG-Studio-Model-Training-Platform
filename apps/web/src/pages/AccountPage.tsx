import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { apiGet, apiSend, ApiError } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { useAuthStore } from '../stores/auth';
import { passkeySupported, passkeyRegister } from '../lib/passkey';
import { Modal } from '../components/Modal';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { EmptyState } from '../components/EmptyState';
import { formatDate } from '../lib/format';

interface Passkey {
  id: string;
  name: string;
  device_type: string | null;
  backed_up: boolean;
  created_at: string;
  last_used_at: string | null;
}

function AddPasskeyDialog({ onClose }: { onClose: () => void }) {
  const csrfToken = useAuthStore((s) => s.csrfToken);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const onAdd = async () => {
    setError(null);
    setPending(true);
    try {
      await passkeyRegister(name.trim() || 'Passkey', csrfToken);
      queryClient.invalidateQueries({ queryKey: ['passkeys'] });
      onClose();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else if (err instanceof Error && err.name === 'NotAllowedError') setError('Passkey registration was cancelled.');
      else setError('Could not register passkey. Please try again.');
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      title="Add a passkey"
      onClose={onClose}
      footer={
        <button className="btn btn-primary" disabled={pending} onClick={onAdd}>
          {pending ? 'Waiting for device…' : 'Create passkey'}
        </button>
      }
    >
      {error && <div className="form-error">{error}</div>}
      <label className="field">
        <span>Name (e.g. “MacBook Touch ID”)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Passkey" />
      </label>
      <div className="hint">Your device will prompt you (Touch ID / Face ID / security key).</div>
    </Modal>
  );
}

function ChangePasswordSection({ onDone }: { onDone: () => void }) {
  const changePassword = useAuthStore((s) => s.changePassword);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await changePassword(current, next, confirm);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change password. Please try again.');
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="card" style={{ maxWidth: 420, marginBottom: '1.5rem' }} onSubmit={onSubmit}>
      <label className="field">
        <span>Current password</span>
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
      </label>
      <label className="field">
        <span>New password</span>
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      </label>
      <label className="field">
        <span>Confirm new password</span>
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
      </label>
      {mismatch && <div className="form-error">Passwords do not match.</div>}
      {error && <div className="form-error">{error}</div>}
      <button className="btn btn-primary" type="submit" disabled={pending || !current || !next || mismatch}>
        {pending ? 'Saving…' : 'Change password'}
      </button>
    </form>
  );
}

export function AccountPage() {
  const user = useAuthStore((s) => s.user);
  const csrfToken = useAuthStore((s) => s.csrfToken);
  const [showAdd, setShowAdd] = useState(false);
  const [showPw, setShowPw] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['passkeys'],
    queryFn: () => apiGet<Passkey[]>('/auth/passkeys'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiSend('DELETE', `/auth/passkeys/${id}`, undefined, csrfToken),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['passkeys'] }),
  });

  return (
    <section className="page">
      <header className="page-head">
        <h2>Account &amp; Security</h2>
      </header>

      <div className="dl" style={{ marginBottom: '1.5rem' }}>
        <div><dt>Username</dt><dd>{user?.username}</dd></div>
        <div><dt>Display name</dt><dd>{user?.display_name}</dd></div>
        <div><dt>Role</dt><dd>{user?.role}</dd></div>
      </div>

      <div className="page-head">
        <h3 style={{ margin: 0, fontSize: '1rem' }}>Password</h3>
        <div className="spacer" />
        <button className="btn btn-sm" onClick={() => setShowPw((v) => !v)}>
          {showPw ? 'Cancel' : 'Change password'}
        </button>
      </div>
      {showPw && <ChangePasswordSection onDone={() => setShowPw(false)} />}

      <div className="page-head">
        <h3 style={{ margin: 0, fontSize: '1rem' }}>Passkeys</h3>
        <div className="spacer" />
        {passkeySupported() && (
          <button className="btn btn-sm" onClick={() => setShowAdd(true)}>Add passkey</button>
        )}
      </div>
      {!passkeySupported() && <div className="hint">This browser does not support passkeys.</div>}

      {isLoading && <SkeletonLoader rows={5} cols={5} />}
      {error && <EmptyState type="error" message={(error as Error).message} />}
      {data && data.length === 0 && <EmptyState message="No passkeys yet. Add one to sign in without a password." />}

      {data && data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Created</th>
                <th>Last used</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id}>
                  <td className="cell-title">{p.name}</td>
                  <td>{p.device_type === 'multiDevice' ? 'Synced' : 'Device-bound'}</td>
                  <td>{formatDate(p.created_at)}</td>
                  <td>{formatDate(p.last_used_at)}</td>
                  <td className="num">
                    <button className="btn btn-sm" disabled={remove.isPending} onClick={() => remove.mutate(p.id)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && <AddPasskeyDialog onClose={() => setShowAdd(false)} />}
    </section>
  );
}
