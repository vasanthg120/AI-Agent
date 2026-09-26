import { axiosClient } from '@/api/axiosClient';
import type {
  AuthSession,
  ForgotPasswordPayload,
  LoginPayload,
  OAuthProvider,
  RegisterPayload,
  ResetPasswordPayload,
  UpdateProfilePayload,
  User,
} from '@/types';

interface BackendTokenResponse {
  accessToken: string;
}

// Discriminated union: 'ok' means a real session was issued (unchanged
// behavior); '2fa_required' means credentials were valid but the account
// has 2FA enabled — no session exists yet, only a short-lived challengeToken
// that must be exchanged via twoFactorService.verifyLoginChallenge before a
// real accessToken is issued. Matches AuthService.LoginResult on the backend
// exactly (backend/src/auth/auth.service.ts).
export type LoginResult = { status: 'ok'; session: AuthSession } | { status: '2fa_required'; challengeToken: string };

interface BackendLoginResponse {
  status: 'ok' | '2fa_required';
  accessToken?: string;
  challengeToken?: string;
}

interface BackendUserProfile {
  id: string;
  email: string;
  name: string;
  roles: string[];
  assignedAgentId?: string;
  department?: string;
  // Self-editable profile fields (PATCH /users/me). Absent until the user
  // first saves them — timezone/language then fall back to the device's.
  phone?: string;
  timezone?: string;
  language?: string;
  createdAt?: string;
}

function toUser(profile: BackendUserProfile): User {
  const [firstName, ...rest] = profile.name.trim().split(/\s+/);
  return {
    id: profile.id,
    email: profile.email,
    firstName: firstName || profile.email,
    lastName: rest.join(' '),
    roles: profile.roles ?? [],
    assignedAgentId: profile.assignedAgentId,
    department: profile.department,
    phone: profile.phone,
    timezone: profile.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: profile.language ?? 'en-US',
    createdAt: profile.createdAt ?? new Date().toISOString(),
  };
}

async function fetchProfile(accessToken: string): Promise<BackendUserProfile> {
  const { data } = await axiosClient.get<BackendUserProfile>('/users/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return data;
}

export const authService = {
  async login(payload: LoginPayload): Promise<LoginResult> {
    const { data } = await axiosClient.post<BackendLoginResponse>('/auth/login', {
      email: payload.email,
      password: payload.password,
    });
    if (data.status === '2fa_required') {
      return { status: '2fa_required', challengeToken: data.challengeToken! };
    }
    const profile = await fetchProfile(data.accessToken!);
    return {
      status: 'ok',
      session: { user: toUser(profile), accessToken: data.accessToken!, refreshToken: '', expiresAt: '' },
    };
  },

  async register(payload: RegisterPayload): Promise<AuthSession> {
    const { data } = await axiosClient.post<BackendTokenResponse>('/auth/register', {
      email: payload.email,
      password: payload.password,
      name: `${payload.firstName} ${payload.lastName}`.trim(),
      // Registration now always creates a new organization (multi-tenant
      // Phase 1) with this user as its owner — the form already collects
      // "Company", it just wasn't being sent before.
      organizationName: payload.company,
    });
    const profile = await fetchProfile(data.accessToken);
    return { user: toUser(profile), accessToken: data.accessToken, refreshToken: '', expiresAt: '' };
  },

  async forgotPassword(payload: ForgotPasswordPayload): Promise<{ maskedEmail: string }> {
    const { data } = await axiosClient.post<{ maskedEmail: string }>('/auth/forgot-password', {
      email: payload.email,
    });
    return data;
  },

  async resetPassword(payload: ResetPasswordPayload): Promise<{ success: true }> {
    await axiosClient.post('/auth/reset-password', {
      email: payload.email,
      otp: payload.otp,
      password: payload.password,
    });
    return { success: true };
  },

  async fetchCurrentUser(accessToken: string): Promise<User> {
    return toUser(await fetchProfile(accessToken));
  },

  // Same as fetchCurrentUser but through the normal authenticated client —
  // for refreshing the signed-in user's own profile.
  async getMe(): Promise<User> {
    const { data } = await axiosClient.get<BackendUserProfile>('/users/me');
    return toUser(data);
  },

  async updateMe(patch: UpdateProfilePayload): Promise<User> {
    const { data } = await axiosClient.patch<BackendUserProfile>('/users/me', patch);
    return toUser(data);
  },

  async getOAuthUrl(provider: OAuthProvider): Promise<string> {
    const { data } = await axiosClient.get<{ url: string }>(`/auth/oauth/${provider}/url`);
    return data.url;
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    // Authorization header is attached automatically by axiosClient's
    // interceptor (reads the live session from authStore) — unlike
    // fetchProfile/login/register above, which run before a session exists.
    await axiosClient.post('/auth/change-password', { currentPassword, newPassword });
  },

  async logout(): Promise<void> {
    // Best-effort — the local session is cleared by authStore.logout()
    // regardless of this call's outcome (same resilience spirit the rest of
    // this app already applies to non-critical calls), so a network hiccup
    // on the way out never traps a user in a "can't log out" state. Revokes
    // the real session server-side (see POST /auth/logout) when it succeeds.
    try {
      await axiosClient.post('/auth/logout');
    } catch {
      // swallowed — see comment above.
    }
  },
};
