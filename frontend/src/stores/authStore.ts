import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { queryClient } from '@/config/queryClient';
import { authService } from '@/services/authService';
import { twoFactorService } from '@/services/twoFactorService';
import { extractErrorMessage } from '@/utils/errors';
import type { AuthSession, LoginPayload, RegisterPayload, User } from '@/types';

export interface LoginOutcome {
  requiresTwoFactor: boolean;
  challengeToken?: string;
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  // Returns rather than always applying a session — a 2FA-enabled account's
  // credentials being valid doesn't mean the sign-in is complete yet (see
  // verifyTwoFactor below, which is what actually applies the session in
  // that case). The non-2FA case behaves exactly as before.
  login: (payload: LoginPayload) => Promise<LoginOutcome>;
  register: (payload: RegisterPayload) => Promise<void>;
  loginWithToken: (token: string) => Promise<void>;
  // Completes a login that returned requiresTwoFactor:true. challengeToken
  // is passed explicitly (never stored in this — persisted — store; see
  // LoginPage's own local state) so it can never be attached as a Bearer
  // header by axiosClient's interceptor or treated as a real session.
  verifyTwoFactor: (challengeToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
}

function applySession(session: AuthSession) {
  return { user: session.user, accessToken: session.accessToken, isAuthenticated: true, error: null };
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,

      async login(payload) {
        set({ isLoading: true, error: null });
        try {
          const result = await authService.login(payload);
          if (result.status === '2fa_required') {
            // Deliberately does NOT touch user/accessToken/isAuthenticated —
            // credentials being valid isn't the same as sign-in being
            // complete. isLoading still clears so the form re-enables for
            // the 2FA-code step.
            set({ isLoading: false, error: null });
            return { requiresTwoFactor: true, challengeToken: result.challengeToken };
          }
          // Wipes any query cache left over from a previous identity in this
          // same tab (a prior session, or a fetch that landed just before a
          // 401 auto-logout) — without this, a stale (possibly another
          // user's) cached response for the same query key (e.g. Board's
          // ['tasks', {dateFrom: today, ...}], identical shape for every
          // user) could render before this session's own fetch ever runs.
          queryClient.clear();
          set({ ...applySession(result.session), isLoading: false });
          return { requiresTwoFactor: false };
        } catch (error) {
          set({ isLoading: false, error: extractErrorMessage(error) });
          throw error;
        }
      },

      async register(payload) {
        set({ isLoading: true, error: null });
        try {
          const session = await authService.register(payload);
          queryClient.clear();
          set({ ...applySession(session), isLoading: false });
        } catch (error) {
          set({ isLoading: false, error: extractErrorMessage(error) });
          throw error;
        }
      },

      // Completes the OAuth redirect flow (see OAuthCallbackPage): the
      // backend already exchanged the provider code and issued a JWT the
      // same shape as login/register issue, this just fetches the profile
      // and applies the session exactly like those do.
      async loginWithToken(token) {
        set({ isLoading: true, error: null });
        try {
          const user = await authService.fetchCurrentUser(token);
          queryClient.clear();
          set({ user, accessToken: token, isAuthenticated: true, isLoading: false, error: null });
        } catch (error) {
          set({ isLoading: false, error: extractErrorMessage(error) });
          throw error;
        }
      },

      async verifyTwoFactor(challengeToken, code) {
        set({ isLoading: true, error: null });
        try {
          const { accessToken } = await twoFactorService.verifyLoginChallenge(challengeToken, code);
          const user = await authService.fetchCurrentUser(accessToken);
          queryClient.clear();
          set({ user, accessToken, isAuthenticated: true, isLoading: false, error: null });
        } catch (error) {
          set({ isLoading: false, error: extractErrorMessage(error) });
          throw error;
        }
      },

      async logout() {
        // Best-effort server-side revoke (see authService.logout's own
        // comment) — local state is always cleared regardless of outcome.
        await authService.logout();
        queryClient.clear();
        set({ user: null, accessToken: null, isAuthenticated: false });
      },

      clearError() {
        set({ error: null });
      },
    }),
    {
      name: 'enterprise-ai:auth',
      partialize: (state) => ({ user: state.user, accessToken: state.accessToken, isAuthenticated: state.isAuthenticated }),
    },
  ),
);
