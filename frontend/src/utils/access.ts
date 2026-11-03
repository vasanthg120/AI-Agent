import type { NavItem, User } from '@/types';
import { hasRole } from './roles';

// The app features an AI role can open up to the people assigned to it — the
// same list the server enforces (backend/src/common/app-features.ts). Everyone
// assigned to an AI role also gets the basics: chat with that agent, dashboard,
// timeline, to-do and EOD.
export const APP_FEATURES = [
  {
    id: 'email_inbox',
    label: 'AI Email Inbox',
    description: 'Their own mailbox, sorted by the AI with drafted replies.',
  },
  { id: 'call_copilot', label: 'Call Copilot', description: 'Live call coaching, summaries and recordings.' },
  { id: 'inquiries', label: 'Customers', description: 'Inquiries, quotes, invoices and email for every customer, across your connected CRMs.' },
  {
    id: 'business_knowledge',
    label: 'Business Knowledge',
    description: 'Read what the AI knows about the business (only admins can change it).',
  },
] as const;
export type AppFeature = (typeof APP_FEATURES)[number]['id'];

/** What an AI role gives when it doesn't say (roles created before features existed). */
export const DEFAULT_ROLE_FEATURES: AppFeature[] = ['email_inbox', 'call_copilot'];

export const BASIC_FEATURES_TEXT = 'AI chat with their agent, Dashboard, Timeline, To-Do and EOD';

/** An account whose access comes from its AI role rather than from a fixed role. */
export function isAiRoleAccount(user: User | null | undefined): boolean {
  return hasRole(user, 'agent_user') && !hasRole(user, 'admin') && !hasRole(user, 'owner');
}

// ---- Page & action permissions -------------------------------------------------
// Someone created with an AI role and their own permission list ("customers:edit")
// is held to exactly that list by the server (backend/src/common/permissions). The
// module ids below are the server's; the catalog itself (labels, actions) is read
// from GET /users/permission-catalog, never copied here.

export type PermissionAction = 'view' | 'create' | 'edit' | 'delete' | 'export' | 'manage';

/** Whether this person's access is their own permission list. */
export function isPermissionManaged(user: User | null | undefined): boolean {
  return isAiRoleAccount(user) && Array.isArray(user?.permissions);
}

/**
 * Whether the signed-in person may do this. Owners and admins may do everything;
 * older accounts are decided by their role and the server, as before (true here,
 * so nothing they could do before disappears).
 */
export function can(user: User | null | undefined, module: string, action: PermissionAction = 'view'): boolean {
  if (!isPermissionManaged(user)) return true;
  return user?.permissions?.includes(`${module}:${action}`) ?? false;
}

/** Whether the person may open at least one of these pages (a page made of several modules). */
export function canViewAny(user: User | null | undefined, module: string | readonly string[]): boolean {
  return (typeof module === 'string' ? [module] : module).some((m) => can(user, m, 'view'));
}

// The page each older AI-role feature stands for.
const FEATURE_MODULE: Record<string, string> = {
  email_inbox: 'email',
  call_copilot: 'call_copilot',
  inquiries: 'customers',
  business_knowledge: 'business_knowledge',
};

/** Whether the signed-in user may use an AI-role-controlled feature. */
export function hasFeature(user: User | null | undefined, feature: string): boolean {
  if (isPermissionManaged(user)) return can(user, FEATURE_MODULE[feature] ?? feature, 'view');
  if (!isAiRoleAccount(user)) return true;
  return user?.features?.includes(feature) ?? false;
}

/** Whether a sidebar / command-palette entry is shown to this user. */
export function canSeeNavItem(user: User | null | undefined, item: NavItem): boolean {
  // Someone with their own permission list sees exactly the pages they may open.
  if (isPermissionManaged(user)) {
    if (!item.module) return !item.hideForRoles?.some((role) => hasRole(user, role));
    return canViewAny(user, item.module);
  }
  // For an AI-role account the role's feature list decides the entries it controls.
  if (item.feature && isAiRoleAccount(user)) return hasFeature(user, item.feature);
  return !item.hideForRoles?.some((role) => hasRole(user, role));
}

/** Who can be given a sales target or a deal: store managers, consultants and
 * team members (accounts tied to an AI role) — not workspace admins, and not
 * someone who can no longer sign in. Mirrors the server's SALES_ROLES. */
export const SALES_ROLE_LABEL: Record<string, string> = {
  agent_user: 'Team member',
  consultant: 'Consultant',
  manager: 'Manager',
};
export function isSalesperson(user: { roles: string[]; active?: boolean }): boolean {
  return user.active !== false && user.roles.some((role) => role in SALES_ROLE_LABEL);
}
