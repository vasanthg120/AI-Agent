// Pure rules for the reporting hierarchy (User.reportingManagerId), kept free of
// database access so they are unit-testable and reusable by work-automation.

export const MAX_HIERARCHY_DEPTH = 50;

/**
 * True when making `managerId` the manager of `userId` would create a loop:
 * the manager is the user, or the user is already somewhere above the manager.
 * `managerOf` returns the given person's current manager id (or undefined).
 * A chain longer than MAX_HIERARCHY_DEPTH (or one that loops on its own) is
 * treated as a cycle so a corrupt chain can never hang a request.
 */
export function wouldCreateCycle(userId: string, managerId: string, managerOf: (id: string) => string | undefined): boolean {
  if (userId === managerId) return true;
  const seen = new Set<string>([managerId]);
  let current: string | undefined = managerOf(managerId);
  for (let depth = 0; current; depth += 1) {
    if (current === userId) return true;
    if (seen.has(current) || depth >= MAX_HIERARCHY_DEPTH) return true;
    seen.add(current);
    current = managerOf(current);
  }
  return false;
}

/** Everyone below `rootId` in the hierarchy (direct and indirect reports), cycle-safe. */
export function descendantsOf(rootId: string, people: { id: string; reportingManagerId?: string }[]): string[] {
  const byManager = new Map<string, string[]>();
  for (const p of people) {
    if (!p.reportingManagerId) continue;
    const list = byManager.get(p.reportingManagerId) ?? [];
    list.push(p.id);
    byManager.set(p.reportingManagerId, list);
  }
  const out: string[] = [];
  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const next = byManager.get(queue.shift() as string) ?? [];
    for (const id of next) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      queue.push(id);
    }
  }
  return out;
}
