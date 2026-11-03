import { JwtPayload } from '../auth/jwt-payload.interface';
import { currentPeriod, periodToDateRange } from '../common/period.util';
import { BiFilterQueryDto } from './dto/bi-filter-query.dto';
import { holdsPermission, isPermissionManaged } from '../common/permissions/permission.decorator';

// Spec requirement: no explicit range means "current month" — same default
// period every other dashboard in this app already uses (period.util.ts).
// Half-open [start, end) UTC range, matching getActivityStats' own $lt
// convention, so a BI section querying the same Date-typed fields never
// disagrees with the already-trusted Analytics Dashboard about a boundary.
export function resolveBiDateRange(filters: { dateFrom?: string; dateTo?: string }): { start: Date; end: Date } {
  if (!filters.dateFrom && !filters.dateTo) return periodToDateRange(currentPeriod());
  const fallback = periodToDateRange(currentPeriod());
  const start = filters.dateFrom ? new Date(`${filters.dateFrom}T00:00:00.000Z`) : fallback.start;
  const end = filters.dateTo
    ? new Date(new Date(`${filters.dateTo}T00:00:00.000Z`).getTime() + 86_400_000)
    : fallback.end;
  return { start, end };
}

// Server-forced scope narrowing shared by every BI controller at the
// owner/admin/manager/consultant RBAC tier — manager is pinned to their own
// store regardless of any client-supplied storeId, consultant is pinned to
// themself regardless of any client-supplied employeeId/storeId. Never trust
// the client's own filter values for scope — same principle as
// deals.controller.ts's canOverride pattern, generalized across every BI
// section so scoping logic can't drift between them.
export function scopeBiFilters<T extends BiFilterQueryDto>(user: JwtPayload, filters: T): T {
  const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
  if (canOverride) return filters;
  // Someone given Revenue & Analytics looks at the business, as an admin does.
  if (isPermissionManaged(user) && holdsPermission(user, 'analytics', 'view')) return filters;
  if (user.roles.includes('manager')) {
    return { ...filters, storeId: user.storeId ? [user.storeId] : [] };
  }
  // consultant (or any other role reaching this guard tier): pinned to self,
  // every other scoping dimension cleared.
  return { ...filters, employeeId: [user.sub], storeId: undefined };
}
