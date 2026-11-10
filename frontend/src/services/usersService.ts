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
  createdAt?: string;
  // Read from their AI role ("Sales Agent"), or Owner / Administrator — never stored.
  accountType?: string;
  // 'full' (owner/admin), 'permissions' (their own list) or 'older' (fixed role / AI role features).
  accessMode?: AccessMode;
  aiRole?: AiRoleSummary | null;
  // Their own page & action permissions ("customers:edit"); null unless accessMode is 'permissions'.
  permissions?: string[] | null;
  // An older team member: what their AI role's features give them today, in the same terms.
  olderPermissions?: string[] | null;
  // Their AI role is gone or back in draft.
  needsAiRole?: boolean;
}

export type AccessMode = 'full' | 'permissions' | 'older';

export interface AiRoleSummary {
  slug: string;
  name: string;
  category: string;
  status: 'active' | 'draft' | 'missing';
  avatarColor?: string;
  description?: string;
}

/** An active AI role a person can be given, with where it starts them. */
export interface AssignableAiRole {
  slug: string;
  name: string;
  description: string;
  category: string;
  avatarColor?: string;
  allowedTools: string[];
  accountType: string;
  defaultPermissions: string[];
  people: number;
}

export type PermissionAction = 'view' | 'create' | 'edit' | 'delete' | 'export' | 'manage';

export interface PermissionModule {
  id: string;
  label: string;
  group: 'workspace' | 'operations' | 'administration';
  description: string;
  actions: PermissionAction[];
  actionHints: Partial<Record<PermissionAction, string>>;
}

/** The server's one list of pages and actions (GET /users/permission-catalog). */
export interface PermissionCatalog {
  groups: { id: PermissionModule['group']; label: string }[];
  modules: PermissionModule[];
  alwaysIncluded: string[];
  notGrantable: string[];
  /** Where a brand-new AI role's people start until the role says otherwise. */
  newRoleDefaults: string[];
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
  // Their own page & action permissions — only with an AI role.
  permissions?: string[];
  // Created switched off (can't sign in until reactivated).
  active?: boolean;
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
  // Replaces their page & action permissions (moves an older account onto its own list).
  permissions?: string[];
}

export const usersService = {
  async permissionCatalog(): Promise<PermissionCatalog> {
    const { data } = await axiosClient.get<PermissionCatalog>('/users/permission-catalog');
    return data;
  },

  async aiRoles(): Promise<AssignableAiRole[]> {
    const { data } = await axiosClient.get<AssignableAiRole[]>('/users/ai-roles');
    return data;
  },

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
