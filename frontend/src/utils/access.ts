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

/** Whether the signed-in user may use an AI-role-controlled feature. */
export function hasFeature(user: User | null | undefined, feature: string): boolean {
  if (!isAiRoleAccount(user)) return true;
  return user?.features?.includes(feature) ?? false;
}

/** Whether a sidebar / command-palette entry is shown to this user. */
export function canSeeNavItem(user: User | null | undefined, item: NavItem): boolean {
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
