import { axiosClient } from '@/api/axiosClient';

export interface BillingSnapshot {
  // A subscription status, or 'none' when it has never had one.
  status: string;
  planName: string | null;
  amount: number | null;
  currency: string | null;
  cycle: string | null;
  renewsAt: string | null;
  cancelAtPeriodEnd: boolean;
  failedRenewals: number;
}

export interface SubAccountRow {
  id: string;
  name: string;
  logo?: string;
  ownerName: string | null;
  email: string | null;
  phoneCountryCode: string | null;
  phone: string | null;
  status: 'active' | 'suspended' | 'archived';
  suspendedByParent: boolean;
  ownerActivated: boolean;
  billing: BillingSnapshot;
  userCount: number;
  createdAt?: string;
  lastActiveAt: string | null;
}

export interface SubAccountsOverview {
  total: number;
  active: number;
  inactive: number;
  pendingSubscriptions: number;
  monthlyRevenue: { currency: string; amount: number }[];
}

export interface SubAccountsList {
  overview: SubAccountsOverview;
  subAccounts: SubAccountRow[];
  plansAvailable: boolean;
}

export interface SubAccountDetails {
  id: string;
  name: string;
  status: SubAccountRow['status'];
  suspendedByParent: boolean;
  timezone: string | null;
  currency: string | null;
  profile: {
    businessEmail?: string;
    phoneCountryCode?: string;
    phone?: string;
    website?: string;
    address?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    logo?: string;
  };
  owner: { name: string; email: string; activated: boolean } | null;
  createdAt?: string;
  archivedAt: string | null;
  lastActiveAt: string | null;
  userCount: number;
  billing: BillingSnapshot;
}

export interface SubAccountForm {
  name: string;
  phoneCountryCode: string;
  phone: string;
  timezone: string;
  currency: string;
  address?: string;
  website?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  logo?: string;
}

export interface CreateSubAccountForm extends SubAccountForm {
  businessEmail: string;
  ownerName?: string;
  sendInvite: boolean;
}

export interface CreatedSubAccount {
  id: string;
  name: string;
  ownerEmail: string;
  invited: boolean;
  activationLink?: string;
}

export interface SubAccountUsers {
  total: number;
  active: number;
  pendingInvitations: number;
  roles: { role: string; count: number }[];
  people: {
    id: string;
    name: string;
    email: string;
    roles: string[];
    active: boolean;
    pendingInvitation: boolean;
    lastActiveAt: string | null;
  }[];
  mainAccountAccess: { loginUserId: string; name: string; email: string; roles: string[]; isMainOwner: boolean }[];
}

export interface SubAccountBilling {
  subscription: BillingSnapshot;
  payments: { id: string; type: string; amount: number; currency: string; status: string; createdAt: string }[];
  invoices: { id: string; number: string; total: number; currency: string; status: string; issuedAt: string }[];
  paymentMethods: { id: string; cardNetwork?: string; last4?: string; isDefault: boolean }[];
}

export interface SubAccountIntegrations {
  crms: { provider: string; label: string; status: string }[];
  outlook: { connected: number; needingReconnection: number };
  cloud: { provider: string; status: string }[];
  connections: { provider: string; updatedAt?: string }[];
}

export interface SubAccountActivity {
  logins: { name: string; device: string; lastSeenAt: string }[];
  changes: { id: string; who: string; what: string; statusCode: number; at: string }[];
  subscriptionEvents: { id: string; type: string; at: string }[];
}

const base = '/sub-accounts';

export const subAccountsService = {
  async list(): Promise<SubAccountsList> {
    return (await axiosClient.get<SubAccountsList>(base)).data;
  },
  async create(form: CreateSubAccountForm): Promise<CreatedSubAccount> {
    return (await axiosClient.post<CreatedSubAccount>(base, form)).data;
  },
  async details(id: string): Promise<SubAccountDetails> {
    return (await axiosClient.get<SubAccountDetails>(`${base}/${id}`)).data;
  },
  async update(id: string, form: Partial<SubAccountForm>): Promise<SubAccountDetails> {
    return (await axiosClient.patch<SubAccountDetails>(`${base}/${id}`, form)).data;
  },
  async setStatus(id: string, status: 'active' | 'suspended'): Promise<SubAccountDetails> {
    return (await axiosClient.post<SubAccountDetails>(`${base}/${id}/status`, { status })).data;
  },
  async archive(id: string, confirmName: string): Promise<SubAccountDetails> {
    return (await axiosClient.post<SubAccountDetails>(`${base}/${id}/archive`, { confirmName })).data;
  },
  async restore(id: string): Promise<SubAccountDetails> {
    return (await axiosClient.post<SubAccountDetails>(`${base}/${id}/restore`)).data;
  },
  async resendInvitation(id: string): Promise<{ email: string; activationLink?: string }> {
    return (await axiosClient.post<{ email: string; activationLink?: string }>(`${base}/${id}/resend-invitation`)).data;
  },
  async users(id: string): Promise<SubAccountUsers> {
    return (await axiosClient.get<SubAccountUsers>(`${base}/${id}/users`)).data;
  },
  async grantableEmployees(id: string): Promise<{ id: string; name: string; email: string }[]> {
    return (await axiosClient.get<{ id: string; name: string; email: string }[]>(`${base}/${id}/grantable-employees`)).data;
  },
  async grantAccess(id: string, userId: string, role: 'admin' | 'manager'): Promise<SubAccountUsers> {
    return (await axiosClient.post<SubAccountUsers>(`${base}/${id}/access`, { userId, role })).data;
  },
  async removeAccess(id: string, userId: string): Promise<SubAccountUsers> {
    return (await axiosClient.delete<SubAccountUsers>(`${base}/${id}/access/${userId}`)).data;
  },
  async billing(id: string): Promise<SubAccountBilling> {
    return (await axiosClient.get<SubAccountBilling>(`${base}/${id}/billing`)).data;
  },
  async integrations(id: string): Promise<SubAccountIntegrations> {
    return (await axiosClient.get<SubAccountIntegrations>(`${base}/${id}/integrations`)).data;
  },
  async activity(id: string): Promise<SubAccountActivity> {
    return (await axiosClient.get<SubAccountActivity>(`${base}/${id}/activity`)).data;
  },
};
