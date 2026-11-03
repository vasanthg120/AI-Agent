import { axiosClient } from '@/api/axiosClient';

// Business-hierarchy roles (owner/manager/consultant) are additive to the
// original admin/agent_user/user set, not a replacement — see
// backend/src/users/dto/update-user.dto.ts's ASSIGNABLE_ROLES. 'owner' is
// registration-only, not assignable here.
export type AssignableRole = 'admin' | 'agent_user' | 'user' | 'manager' | 'consultant';

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  roles: string[];
  assignedAgentId?: string;
  storeId?: string;
  // Free-text, matches AgentRole.department's convention — used to grant
  // this user chat access to any custom persona restricted to this
  // department (see chat.service.ts's listAgents, Phase 6).
  department?: string;
  active: boolean;
  // Provider/model-availability control, NOT an AI on/off switch — chat
  // stays automatically available regardless of this field; it only gates
  // the separate voice (Sarvam) feature. Defaults true.
  voiceAccessEnabled: boolean;
  // Whether this person may use AI features on the organization's credits —
  // enforced by the server on every AI request. Defaults true.
  aiAccessEnabled?: boolean;
  // Has access through the Main Account rather than being one of this business's
  // own people; it can only be changed from the Main Account.
  linkedFromMain?: boolean;
  // Invited and hasn't set a password yet.
  pendingInvitation?: boolean;
}

export interface CreateUserPayload {
  email: string;
  name: string;
  role: AssignableRole;
  assignedAgentId?: string;
  storeId?: string;
  department?: string;
  voiceAccessEnabled?: boolean;
  aiAccessEnabled?: boolean;
  // Email them a link to set their own password instead of a temporary one.
  sendInvite?: boolean;
}

export interface CreateUserResult {
  user: AdminUser;
  // Exactly one of these, depending on sendInvite.
  tempPassword?: string;
  activationLink?: string;
}

export interface UpdateUserPayload {
  name?: string;
  role?: AssignableRole;
  assignedAgentId?: string;
  storeId?: string;
  active?: boolean;
  department?: string;
  voiceAccessEnabled?: boolean;
  aiAccessEnabled?: boolean;
}

export const usersService = {
  async resendInvitation(id: string): Promise<{ activationLink?: string }> {
    const { data } = await axiosClient.post<{ activationLink?: string }>(`/users/${id}/resend-invitation`);
    return data;
  },

  async list(): Promise<AdminUser[]> {
    const { data } = await axiosClient.get<AdminUser[]>('/users');
    return data;
  },

  async create(payload: CreateUserPayload): Promise<CreateUserResult> {
    const { data } = await axiosClient.post<CreateUserResult>('/users', payload);
    return data;
  },

  async update(id: string, patch: UpdateUserPayload): Promise<AdminUser> {
    const { data } = await axiosClient.patch<AdminUser>(`/users/${id}`, patch);
    return data;
  },

  async remove(id: string): Promise<void> {
    await axiosClient.delete(`/users/${id}`);
  },
};
