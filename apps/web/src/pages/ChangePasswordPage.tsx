import { useState } from 'react';
import { useAuthStore } from '../stores/auth';
import { ApiError } from '../lib/api';

export function ChangePasswordPage() {
  const changePassword = useAuthStore((s) => s.changePassword);
  const logout = useAuthStore((s) => s.logout);
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
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change password. Please try again.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={onSubmit}>
        <h1 className="login-title">Set a new password</h1>
        <p className="login-sub">Your account requires a password change before you continue.</p>
        <label className="field">
          <span>Current password</span>
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus autoComplete="current-password" />
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
        <button type="button" className="btn btn-ghost" style={{ marginTop: '0.6rem', width: '100%' }} onClick={() => void logout()}>
          Sign out
        </button>
      </form>
    </div>
  );
}
