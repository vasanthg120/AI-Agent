import { ExecutionContext, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtPayload } from '../../auth/jwt-payload.interface';
import { isAiRoleAccount } from '../app-features';
import { actionForMethod, AppModuleId, moduleById, PermissionAction, permissionKey } from './app-modules';

export const PERMISSION_KEY = 'app-module-permission';
export const PERMISSION_EXEMPT_KEY = 'app-module-permission-exempt';
export const NOT_DELEGABLE_KEY = 'app-module-not-delegable';

/**
 * Marks a controller (or one route) as part of a module of the permission
 * catalog. The action comes from the HTTP method (GET view, POST create,
 * PATCH/PUT edit, DELETE delete) unless given — a POST that only searches says
 * 'view', a download says 'export'. On a route it replaces the controller's.
 */
export const Permission = (module: AppModuleId, action?: PermissionAction) => SetMetadata(PERMISSION_KEY, { module, action });

/**
 * Why a controller or route belongs to no module, so the coverage test knows it
 * was decided rather than forgotten:
 * - personal: the person's own things (profile, security, notifications, to-do)
 * - not_grantable: decided by role as before, never by a permission list (billing, sub-accounts, audit)
 * - platform: HaiVE's own admin panel, a separate login
 * - public: no login (webhooks, OAuth callbacks, health)
 */
export type PermissionExemptReason = 'personal' | 'not_grantable' | 'platform' | 'public';
export const PermissionExempt = (reason: PermissionExemptReason) => SetMetadata(PERMISSION_EXEMPT_KEY, reason);

/** A route that stays owner/admin only even inside a module someone was given. */
export const NotDelegable = () => SetMetadata(NOT_DELEGABLE_KEY, true);

export interface RoutePermission {
  module: string;
  action: PermissionAction;
  label: string;
}

/** The module and action a request needs, or null when the route belongs to no module. */
export function routePermission(reflector: Reflector, context: ExecutionContext): RoutePermission | null {
  const method = context.getType() === 'http' ? (context.switchToHttp().getRequest().method as string) : 'GET';
  return permissionFor(reflector, context.getHandler(), context.getClass(), method);
}

/** routePermission for a handler and its controller directly (the coverage test walks every route this way). */
// eslint-disable-next-line @typescript-eslint/ban-types
export function permissionFor(reflector: Reflector, handler: Function, cls: Function, method: string): RoutePermission | null {
  // The route's own marking wins over its controller's, whichever kind it is.
  let tag = reflector.get<{ module: string; action?: PermissionAction } | undefined>(PERMISSION_KEY, handler);
  if (!tag) {
    if (reflector.get(PERMISSION_EXEMPT_KEY, handler)) return null;
    tag = reflector.get<{ module: string; action?: PermissionAction } | undefined>(PERMISSION_KEY, cls);
  }
  if (!tag) return null;
  const definition = moduleById(tag.module);
  let action = tag.action ?? actionForMethod(method);
  // A page with only view and manage: every change there is managing it.
  if (definition && action !== 'view' && !definition.actions.includes(action) && definition.actions.includes('manage')) action = 'manage';
  return { module: tag.module, action, label: definition?.label ?? tag.module };
}

export function isNotDelegable(reflector: Reflector, context: ExecutionContext): boolean {
  return !!reflector.getAllAndOverride<boolean | undefined>(NOT_DELEGABLE_KEY, [context.getHandler(), context.getClass()]);
}

/**
 * A person whose access is their own permission list: created with an AI role
 * and given permissions. Owners and admins never are (they have everything), and
 * older accounts without a list keep the rules they had.
 */
export function isPermissionManaged(user: Pick<JwtPayload, 'roles' | 'permissions'> | null | undefined): boolean {
  return !!user && Array.isArray(user.permissions) && isAiRoleAccount(user.roles);
}

export function holdsPermission(user: Pick<JwtPayload, 'permissions'> | null | undefined, module: string, action: PermissionAction): boolean {
  return !!user?.permissions?.includes(permissionKey(module, action));
}

const ACTION_VERB: Record<PermissionAction, string> = {
  view: 'open',
  create: 'add to',
  edit: 'change',
  delete: 'delete from',
  export: 'export from',
  manage: 'manage',
};

export function permissionDeniedMessage(need: RoutePermission): string {
  return `You don’t have permission to ${ACTION_VERB[need.action]} ${need.label}. Ask an admin for access.`;
}
