import { axiosClient } from '@/api/axiosClient';

export type AccountType = 'main' | 'sub';

export interface AccountSummary {
  id: string;
  name: string;
  logo?: string;
  accountType: AccountType;
  status: 'active' | 'suspended' | 'archived';
  // A subscription status, or 'none' when it has never had one.
  subscriptionStatus: string;
  planName: string | null;
  isHome: boolean;
  isCurrent: boolean;
}

// Only the businesses this login may enter — the server decides, never this page.
export interface AccountsResponse {
  accounts: AccountSummary[];
  currentOrganizationId: string;
  homeOrganizationId: string;
  canManageSubAccounts: boolean;
  // A sub-account with no live subscription: only billing and account settings work.
  locked: boolean;
}

export const accountsService = {
  async list(): Promise<AccountsResponse> {
    const { data } = await axiosClient.get<AccountsResponse>('/organizations/accounts');
    return data;
  },

  async switchTo(organizationId: string): Promise<{ accessToken: string }> {
    const { data } = await axiosClient.post<{ accessToken: string }>('/organizations/switch', { organizationId });
    return data;
  },
};
