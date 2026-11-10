export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  company?: string;
  roles: string[];
  assignedAgentId?: string;
  // For an account tied to an AI role: that role's name and the app features it includes.
  aiRoleName?: string;
  features?: string[];
  // Someone created with their own page & action permissions ("customers:edit");
  // null for owners, admins and older accounts (see utils/access.ts).
  permissions?: string[] | null;
  // 'full' (owner/admin), 'permissions' (their own list) or 'older' (fixed role / AI role features).
  accessMode?: 'full' | 'permissions' | 'older';
  // Read from their AI role ("Sales Agent"), or Owner / Administrator.
  accountType?: string;
  avatarUrl?: string;
  timezone?: string;
  language?: string;
  phone?: string;
  department?: string;
  createdAt: string;
}

// What a user may change about themselves via PATCH /users/me.
export interface UpdateProfilePayload {
  name?: string;
  phone?: string;
  timezone?: string;
  language?: string;
  // A small image as a data URL; '' removes the photo.
  avatar?: string;
}

export interface AuthSession {
  user: User;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export interface LoginPayload {
  email: string;
  password: string;
  rememberMe: boolean;
}

export interface RegisterPayload {
  firstName: string;
  lastName: string;
  company: string;
  email: string;
  phone: string;
  password: string;
  confirmPassword: string;
  acceptTerms: boolean;
  marketingConsent: boolean;
}

export interface ForgotPasswordPayload {
  email: string;
}

export interface ResetPasswordPayload {
  email: string;
  otp: string;
  password: string;
  confirmPassword: string;
}

export type OAuthProvider = 'google' | 'microsoft' | 'github';
