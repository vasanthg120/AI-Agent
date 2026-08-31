import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { adminAuthService, type AdminAccount } from '@/services/adminAuthService';
import { extractErrorMessage } from '@/utils/errors';

interface AdminAuthState {
  admin: AdminAccount | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  clearError: () => void;
}

// A fully separate persisted store from useAuthStore — its own localStorage
// key, so an admin session and a customer session can coexist in the same
// browser without clobbering each other (the old design shared one store/key,
// meaning logging into either signed the other one out). See
// adminAxiosClient.ts for how this token gets attached to admin API calls.
export const useAdminAuthStore = create<AdminAuthState>()(
  persist(
    (set) => ({
      admin: null,
      accessToken: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,

      async login(email, password) {
        set({ isLoading: true, error: null });
        try {
          const { accessToken, admin } = await adminAuthService.login(email, password);
          set({ admin, accessToken, isAuthenticated: true, isLoading: false, error: null });
        } catch (error) {
          set({ isLoading: false, error: extractErrorMessage(error) });
          throw error;
        }
      },

      logout() {
        // Stateless JWT, no server-side session to revoke (see
        // AdminAuthService — no jti/sessions tracking) — clearing local
        // state is the entire logout.
        set({ admin: null, accessToken: null, isAuthenticated: false });
      },

      clearError() {
        set({ error: null });
      },
    }),
    {
      name: 'haive-admin:auth',
      partialize: (state) => ({ admin: state.admin, accessToken: state.accessToken, isAuthenticated: state.isAuthenticated }),
    },
  ),
);
