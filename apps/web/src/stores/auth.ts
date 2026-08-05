import { create } from 'zustand';
import { startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { apiGet, apiSend, ApiError, readCsrfCookie } from '../lib/api';
import { resetUiStoreForNewSession } from './ui';
import { queryClient } from '../lib/queryClient';

export interface User {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  role: string;
  status: string;
  must_change_password: boolean;
  last_login_at: string | null;
  permissions?: string[];
}

// POST /auth/login returns the user nested under `user` alongside the csrf token,
// whereas GET /auth/me returns the user fields flat. Keep the two shapes distinct.
interface LoginResponse {
  user: User;
  csrfToken: string;
}

interface AuthState {
  user: User | null;
  csrfToken: string | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<void>;
  passkeyLogin: (username?: string) => Promise<void>;
  logout: () => Promise<void>;
  bootstrap: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string, confirmation: string) => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  csrfToken: null,
  ready: false,

  login: async (username, password) => {
    const res = await apiSend<LoginResponse>('POST', '/auth/login', { username, password });
    resetUiStoreForNewSession();
    queryClient.clear();
    set({ user: res.user, csrfToken: res.csrfToken });
  },

  passkeyLogin: async (username?: string) => {
    const optionsJSON = await apiSend<PublicKeyCredentialRequestOptionsJSON>(
      'POST',
      '/auth/passkeys/login/options',
      { username: username || undefined },
    );
    const response = await startAuthentication({ optionsJSON });
    const res = await apiSend<LoginResponse>('POST', '/auth/passkeys/login/verify', { response });
    resetUiStoreForNewSession();
    queryClient.clear();
    set({ user: res.user, csrfToken: res.csrfToken });
  },

  logout: async () => {
    const { csrfToken } = useAuthStore.getState();
    try {
      await apiSend('POST', '/auth/logout', undefined, csrfToken ?? readCsrfCookie());
    } finally {
      resetUiStoreForNewSession();
      queryClient.clear();
      set({ user: null, csrfToken: null });
    }
  },

  bootstrap: async () => {
    try {
      // /auth/me does not return the csrf token — restore it from the cookie.
      const user = await apiGet<User>('/auth/me');
      set({ user, csrfToken: readCsrfCookie() });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        set({ user: null, csrfToken: null });
      } else {
        throw e;
      }
    } finally {
      set({ ready: true });
    }
  },

  changePassword: async (currentPassword, newPassword, confirmation) => {
    const { csrfToken } = useAuthStore.getState();
    await apiSend(
      'POST',
      '/auth/change-password',
      { current_password: currentPassword, new_password: newPassword, new_password_confirmation: confirmation },
      csrfToken ?? readCsrfCookie(),
    );
    // Refresh the user so must_change_password flips to false.
    await useAuthStore.getState().bootstrap();
  },
}));
