// Who the team dashboards report on — one definition, used by every one of
// them (email response, workload, deal performance, leaderboards), so a person
// can never appear in one widget and be missing from the next.
//
// Someone is on the team when their account type is one that does sales work
// (a team member tied to an AI role, a consultant, a store manager), OR when
// they demonstrably do the work whatever their account type: they have a
// connected mailbox, or deals assigned to them.
//
// The organization's owner is never an employee, whatever they have connected
// or been assigned: the owner runs the workspace and reads these dashboards,
// and is not measured on them. Deactivated accounts are never listed either.
export const TEAM_ROLES = new Set(['manager', 'consultant', 'agent_user']);

export function hasTeamRole(roles: string[] | undefined): boolean {
  return (roles ?? []).some((role) => TEAM_ROLES.has(role));
}

export function isOwner(roles: string[] | undefined): boolean {
  return (roles ?? []).includes('owner');
}
