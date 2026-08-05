import { useState } from 'react';
import { useAuthStore } from '../stores/auth';
import { ApiError } from '../lib/api';
import { passkeySupported } from '../lib/passkey';

export function LoginPage() {
  const login = useAuthStore((s) => s.login);
  const passkeyLogin = useAuthStore((s) => s.passkeyLogin);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [passkeyPending, setPasskeyPending] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed. Please try again.');
    } finally {
      setPending(false);
    }
  };

  const onPasskey = async () => {
    setError(null);
    setPasskeyPending(true);
    try {
      await passkeyLogin(username.trim() || undefined);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else if (err instanceof Error && err.name === 'NotAllowedError') setError('Passkey sign-in was cancelled.');
      else setError('Passkey sign-in failed. Please try again or use your password.');
    } finally {
      setPasskeyPending(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={onSubmit}>
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <img src="/ikg-logo.svg" alt="IKG logo" style={{ width: 90, height: 'auto', filter: 'drop-shadow(0 4px 16px rgba(0,0,0,0.5))', marginBottom: '0.5rem' }} />
          <h1 className="login-title"><span className="brand-accent">IKG</span> Studio</h1>
          <p className="login-sub">Model Training Platform</p>
        </div>
        <label className="field">
          <span>Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="login-actions">
          <button className="btn btn-primary" type="submit" disabled={pending || passkeyPending || !username || !password}>
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
          {passkeySupported() && (
            <>
              <span className="login-actions-or">or</span>
              <button type="button" className="btn" disabled={pending || passkeyPending} onClick={onPasskey}>
                {passkeyPending ? 'Waiting for passkey…' : '🔑 Sign in with a passkey'}
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
