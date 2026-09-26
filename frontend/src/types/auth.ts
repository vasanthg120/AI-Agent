export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  company?: string;
  roles: string[];
  assignedAgentId?: string;
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
