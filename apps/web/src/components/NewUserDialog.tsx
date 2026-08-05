import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiSend } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { useAuthStore } from '../stores/auth';
import { Modal } from './Modal';

type Role = 'ADMIN' | 'USER';
type PasswordMode = 'MANUAL' | 'GENERATED';

export function NewUserDialog({ onClose }: { onClose: () => void }) {
  const csrfToken = useAuthStore((s) => s.csrfToken);

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('USER');
  const [passwordMode, setPasswordMode] = useState<PasswordMode>('MANUAL');
  const [password, setPassword] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      apiSend(
        'POST',
        '/admin/users',
        {
          username,
          display_name: displayName,
          email: email || null,
          role,
          password_mode: passwordMode,
          password: passwordMode === 'MANUAL' ? password : undefined,
        },
        csrfToken,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      onClose();
    },
  });

  return (
    <Modal
      title="New User"
      onClose={onClose}
      footer={
        <button
          className="btn btn-primary"
          disabled={
            mutation.isPending ||
            !username ||
            !displayName ||
            (passwordMode === 'MANUAL' && !password)
          }
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? 'Creating…' : 'Create'}
        </button>
      }
    >
      {mutation.error && (
        <div className="form-error">{(mutation.error as Error).message}</div>
      )}
      <label className="field">
        <span>Username</span>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
      </label>
      <label className="field">
        <span>Display name</span>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </label>
      <label className="field">
        <span>Email (optional)</span>
        <input value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="field">
        <span>Role</span>
        <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="USER">USER</option>
          <option value="ADMIN">ADMIN</option>
        </select>
      </label>
      <label className="field">
        <span>Password mode</span>
        <select
          value={passwordMode}
          onChange={(e) => setPasswordMode(e.target.value as PasswordMode)}
        >
          <option value="MANUAL">MANUAL</option>
          <option value="GENERATED">GENERATED</option>
        </select>
      </label>
      {passwordMode === 'MANUAL' && (
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
      )}
    </Modal>
  );
}
