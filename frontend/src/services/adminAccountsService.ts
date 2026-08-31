import { adminAxiosClient } from '@/api/adminAxiosClient';
import type { AdminAccount } from './adminAuthService';

// Manages the AdminAccount collection itself — backend/src/auth/admin-accounts.controller.ts,
// gated by AdminJwtAuthGuard only (a fully separate credential, not a role
// tag on a customer User). Replaces the old "promote an existing customer"
// grant/revoke flow: an admin account only ever exists because it was
// created here.
export const adminAccountsService = {
  async list(): Promise<AdminAccount[]> {
    const { data } = await adminAxiosClient.get<AdminAccount[]>('/auth/admin/accounts');
    return data;
  },

  async create(dto: { email: string; password: string; name: string }): Promise<AdminAccount> {
    const { data } = await adminAxiosClient.post<AdminAccount>('/auth/admin/accounts', dto);
    return data;
  },

  async setActive(id: string, active: boolean): Promise<AdminAccount> {
    const { data } = await adminAxiosClient.post<AdminAccount>(`/auth/admin/accounts/${id}/${active ? 'activate' : 'deactivate'}`);
    return data;
  },
};
