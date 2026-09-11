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
}

export interface CreateUserPayload {
  email: string;
  name: string;
  role: AssignableRole;
  assignedAgentId?: string;
  storeId?: string;
  department?: string;
  voiceAccessEnabled?: boolean;
}

export interface CreateUserResult {
  user: AdminUser;
  tempPassword: string;
}

export interface UpdateUserPayload {
  role?: AssignableRole;
  assignedAgentId?: string;
  storeId?: string;
  active?: boolean;
  department?: string;
  voiceAccessEnabled?: boolean;
}

export const usersService = {
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
