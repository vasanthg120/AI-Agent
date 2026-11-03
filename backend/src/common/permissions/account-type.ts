// A person's account type is never stored: it is read from what they are now.
// For someone with an AI role it comes from that role's category ("Sales" →
// "Sales Agent"), or the role's own name for a custom one, so renaming or
// recategorising the AI role changes it everywhere at once.

export type AiRoleStatus = 'active' | 'draft' | 'missing';

export interface AiRoleSummary {
  slug: string;
  name: string;
  category: string;
  status: AiRoleStatus;
  avatarColor?: string;
  description?: string;
}

const CATEGORY_ACCOUNT_TYPE: Record<string, string> = {
  sales: 'Sales Agent',
  finance: 'Finance Agent',
  hr: 'HR Agent',
  support: 'Customer Support Agent',
  marketing: 'Marketing Agent',
  operations: 'Operations Agent',
};

// Older fixed account types, shown for the accounts that still have one.
const OLDER_TYPES: Record<string, string> = {
  manager: 'Manager',
  consultant: 'Consultant',
  user: 'Standard user',
};

export function accountTypeOf(roles: readonly string[], aiRole: AiRoleSummary | null): string {
  if (roles.includes('owner')) return 'Owner';
  if (roles.includes('admin')) return 'Administrator';
  if (roles.includes('agent_user')) {
    if (!aiRole || aiRole.status === 'missing') return 'AI role unavailable';
    return CATEGORY_ACCOUNT_TYPE[aiRole.category] ?? aiRole.name;
  }
  return OLDER_TYPES[roles[0]] ?? 'Standard user';
}

/** How a person's access is decided: everything, their own list, or the older rules. */
export type AccessMode = 'full' | 'permissions' | 'older';

export function accessModeOf(roles: readonly string[], permissions: readonly string[] | undefined): AccessMode {
  if (roles.includes('owner') || roles.includes('admin')) return 'full';
  if (roles.includes('agent_user') && Array.isArray(permissions)) return 'permissions';
  return 'older';
}
