import { SetMetadata } from '@nestjs/common';

// The parts of the app an AI role can open up to the people assigned to it.
//
// A team member's account is tied to one AI role (User.assignedAgentId). They
// always get the basics — chat with that agent, dashboard, timeline, to-do and
// EOD — and, on top, whichever of these features their AI role lists. The list
// is set per AI role (Settings → AI Roles) and checked by the server on every
// request (FeatureGuard / RolesGuard), not just hidden in the menu.
//
// Accounts that are not tied to an AI role (owner, admin, manager, consultant,
// standard user) are not affected by any of this: their fixed role decides.
export const APP_FEATURES = ['email_inbox', 'call_copilot', 'inquiries', 'business_knowledge'] as const;
export type AppFeature = (typeof APP_FEATURES)[number];

/** What an AI role gives when it doesn't say (roles created before this existed). */
export const DEFAULT_ROLE_FEATURES: AppFeature[] = ['email_inbox', 'call_copilot'];

export const FEATURE_KEY = 'app-feature';

/** Marks a controller (or one route) as belonging to an app feature. */
export const Feature = (feature: AppFeature) => SetMetadata(FEATURE_KEY, feature);

/** An account whose access comes from its AI role rather than from a fixed role. */
export function isAiRoleAccount(roles: string[] | undefined): boolean {
  const list = roles ?? [];
  return list.includes('agent_user') && !list.includes('admin') && !list.includes('owner');
}
