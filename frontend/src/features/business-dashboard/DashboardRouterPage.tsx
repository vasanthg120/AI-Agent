import { FiBarChart2 } from 'react-icons/fi';
import { EmptyState, Skeleton } from '@/components/ui';
import { useAccounts } from '@/features/sub-accounts/useAccounts';
import { useAuthStore } from '@/stores/authStore';
import { hasRole } from '@/utils/roles';
import { can, isPermissionManaged } from '@/utils/access';
import { DashboardPage as AgentWorkforceDashboardPage } from '@/features/dashboard/DashboardPage';
import { AnalyticsDashboardPage } from '@/features/analytics-dashboard/AnalyticsDashboardPage';

// Phase 19 — the business-hierarchy roles (owner/manager/consultant) now all
// render the single Unified Analytics Dashboard (role-scoped internally by
// the backend), replacing the previous three separate OwnerDashboardView/
// ManagerDashboardView/ConsultantDashboardView components. Those files, and
// their backing GET /home-dashboard/{role} + GET /crm/dashboard/{role}
// endpoints, are left completely intact and untouched (not deleted) — this
// is the literal mechanism for the user's own confirmed two-step sequencing
// ("implement the new dashboard first, remove the old ones only later, once
// reviewed and explicitly confirmed"). They simply become unreachable via
// this router the moment it stops calling them, same as this exact route
// swap happened once before in this app's history (Phase 3). Deal
// Performance and Agent Activity are NOT touched by this pass at all —
// both keep their own live routes/nav entries for direct comparison.
// Accounts with no business-hierarchy role (a plain admin or agent_user
// account) keep falling back to the original AI-workforce dashboard.
export function DashboardRouterPage() {
  const user = useAuthStore((s) => s.user);
  const { data: accounts, isLoading } = useAccounts();

  if (hasRole(user, 'owner') || hasRole(user, 'manager') || hasRole(user, 'consultant')) {
    return <AnalyticsDashboardPage />;
  }
  // Someone with their own permission list: Revenue & Analytics if they were given
  // it, otherwise the agent dashboard if they were given that.
  if (isPermissionManaged(user)) {
    if (can(user, 'analytics')) return <AnalyticsDashboardPage />;
    if (can(user, 'dashboard')) return <AgentWorkforceDashboardPage />;
    return (
      <EmptyState
        icon={FiBarChart2}
        title="No dashboard in your access"
        description="Your access doesn’t include the dashboard. Use the menu to open the pages you can use, or ask an admin."
      />
    );
  }
  // Waits for the answer below rather than opening the wrong dashboard for a moment.
  if (isLoading) return <Skeleton height={320} />;
  // Someone who has entered from their Main Account is there to see how that business
  // is doing, so they get the dashboard its own owner gets. Their role there is 'admin'
  // only because 'owner' belongs to the business's own owner.
  if (accounts && accounts.currentOrganizationId !== accounts.homeOrganizationId) {
    return <AnalyticsDashboardPage />;
  }
  return <AgentWorkforceDashboardPage />;
}
