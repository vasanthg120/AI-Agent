// Single source of truth for "does this task belong to this viewer" — reused
// by TasksService (GET /tasks, GET /tasks/calendar) and
// StoreSettingsService.sendEodEmail (so each recipient's email matches what
// they'd see on the page), so the two can never drift apart.
//
// Deliberately "assigned to me OR still unassigned" rather than a strict
// "only tasks with assignedUserId === me" filter — attribution is best-effort
// (see dashboard.service.ts's attributeTask) and most tasks never resolve to
// a specific owner, so a strict filter would show most users an empty board
// by default. An unassigned task is nobody's individually-owned task yet, not
// "someone else's" — showing it to everyone doesn't leak another user's data.
export function isTaskVisibleToUser<T extends { assignedUserId?: string }>(task: T, userId: string): boolean {
  return !task.assignedUserId || task.assignedUserId === userId;
}
