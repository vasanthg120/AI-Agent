import { ROUTES } from '@/constants/routes';
import type { AppNotification, NotificationEntityType } from '@/services/mock/fixtures/notifications';

// The map every one of the 7 "click notification -> open exact record"
// cases (see the notification schema's NOTIFICATION_ENTITY_TYPES comment)
// resolves through. Adding a new entity type is one line here (route +
// query param name) plus wiring that param on the destination page — see
// EmailIntelligencePage.tsx/FinancePage.tsx for the two currently wired.
// Entries with no queryParam (deal/task/outlookAccount/dailyReport)
// navigate to the right page today; the page doesn't yet auto-open the
// specific record — that's the per-page work described in the PR/commit
// notes, not something this map can do on its own.
const ENTITY_TARGETS: Record<NotificationEntityType, { route: string; queryParam?: string }> = {
  email: { route: ROUTES.emailIntelligence, queryParam: 'openEmailId' },
  financeDocument: { route: ROUTES.finance, queryParam: 'openDocumentId' },
  deal: { route: ROUTES.dealPerformance },
  task: { route: ROUTES.todoEod },
  outlookAccount: { route: ROUTES.settingsIntegrations },
  dailyReport: { route: ROUTES.todoEod },
  // Opens Haive on that briefing, wherever the dashboard is (AssistantVoice reads ?haive=).
  assistantBriefing: { route: ROUTES.dashboard, queryParam: 'haive' },
};

/** Returns the path+query string to navigate to for this notification, or
 * null if it isn't about one specific record (e.g. "Achievement unlocked")
 * — callers should fall back to just showing the in-page detail panel
 * (title/description/etc.) in that case, same as before this existed. */
export function resolveNotificationTarget(notification: AppNotification): string | null {
  if (!notification.entityType || !notification.entityId) return null;
  const target = ENTITY_TARGETS[notification.entityType];
  if (!target) return null;
  if (!target.queryParam) return target.route;
  return `${target.route}?${target.queryParam}=${encodeURIComponent(notification.entityId)}`;
}
