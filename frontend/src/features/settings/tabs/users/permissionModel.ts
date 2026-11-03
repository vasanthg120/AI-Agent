import type { PermissionAction, PermissionCatalog } from '@/services/usersService';

// The same rules the server applies when it saves a permission list
// (backend/src/common/permissions/app-modules.ts normalizePermissions): any action
// brings its page's "view" with it, and turning a page off removes all of it.
// Applying them here keeps what the grid shows identical to what gets saved.

const moduleOf = (key: string) => key.split(':')[0];

export function key(module: string, action: PermissionAction): string {
  return `${module}:${action}`;
}

/** Every permission in the catalog, in its order. */
export function allPermissions(catalog: PermissionCatalog): string[] {
  return catalog.modules.flatMap((m) => m.actions.map((a) => key(m.id, a)));
}

/** Known entries only, each action with its page's view, in catalog order. */
export function normalize(list: readonly string[], catalog: PermissionCatalog): string[] {
  const known = new Set(allPermissions(catalog));
  const wanted = new Set(list.filter((k) => known.has(k)));
  for (const k of [...wanted]) wanted.add(key(moduleOf(k), 'view'));
  return allPermissions(catalog).filter((k) => wanted.has(k));
}

export function setPage(list: readonly string[], module: string, on: boolean, catalog: PermissionCatalog): string[] {
  if (!on) return list.filter((k) => moduleOf(k) !== module);
  return normalize([...list, key(module, 'view')], catalog);
}

export function setAction(list: readonly string[], module: string, action: PermissionAction, on: boolean, catalog: PermissionCatalog): string[] {
  // Without "view" nothing else on the page means anything.
  if (action === 'view' && !on) return setPage(list, module, false, catalog);
  if (!on) return list.filter((k) => k !== key(module, action));
  return normalize([...list, key(module, action)], catalog);
}

/** "9 pages, 23 actions" — pages they can open, and what they can do there beyond opening it. */
export function summarize(list: readonly string[]): { pages: number; actions: number } {
  return {
    pages: list.filter((k) => k.endsWith(':view')).length,
    actions: list.filter((k) => !k.endsWith(':view')).length,
  };
}

export function summaryText(list: readonly string[]): string {
  const { pages, actions } = summarize(list);
  if (pages === 0) return 'Only the basics';
  return `${pages} ${pages === 1 ? 'page' : 'pages'}, ${actions} ${actions === 1 ? 'action' : 'actions'}`;
}

export const ACTION_LABEL: Record<PermissionAction, string> = {
  view: 'View',
  create: 'Create',
  edit: 'Edit',
  delete: 'Delete',
  export: 'Export',
  manage: 'Manage',
};

/** The pages of a list, by label, in catalog order: "Customers, Job Board, Files". */
export function pageLabels(list: readonly string[], catalog: PermissionCatalog): string[] {
  const pages = new Set(list.filter((k) => k.endsWith(':view')).map(moduleOf));
  return catalog.modules.filter((m) => pages.has(m.id)).map((m) => m.label);
}
