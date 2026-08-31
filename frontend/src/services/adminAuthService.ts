import { adminAxiosClient } from '@/api/adminAxiosClient';

export interface AdminAccount {
  id: string;
  email: string;
  name: string;
  active: boolean;
}

export interface AdminLoginResult {
  accessToken: string;
  admin: AdminAccount;
}

// Talks to /auth/admin/* — a fully separate login API from authService.ts's
// /auth/*, never shares a request/response shape with the customer session.
export const adminAuthService = {
  async login(email: string, password: string): Promise<AdminLoginResult> {
    const { data } = await adminAxiosClient.post<AdminLoginResult>('/auth/admin/login', { email, password });
    return data;
  },
};
