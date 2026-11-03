import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtPayload } from '../../auth/jwt-payload.interface';
import { AppFeature, FEATURE_KEY, isAiRoleAccount } from '../app-features';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { holdsPermission, isNotDelegable, isPermissionManaged, permissionDeniedMessage, routePermission } from '../permissions/permission.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true; // no @Roles() → unrestricted

    const user = context.switchToHttp().getRequest().user as JwtPayload | undefined;
    const userRoles = user?.roles ?? []; // null-safe — fail closed, never throw
    if (required.some((r) => userRoles.includes(r))) return true;

    // A person with their own permission list (common/permissions): on a route that
    // belongs to a module, what they were given decides. Only where an admin could
    // do it — owner-only and platform routes, and routes marked NotDelegable, stay
    // exactly as strict as they say.
    if (isPermissionManaged(user)) {
      const need = routePermission(this.reflector, context);
      const delegable = !!need && required.includes('admin') && !isNotDelegable(this.reflector, context);
      if (delegable && holdsPermission(user, need.module, need.action)) return true;
      throw new ForbiddenException(delegable ? permissionDeniedMessage(need) : 'Insufficient role');
    }

    // An account tied to an AI role may use a feature that AI role includes
    // (see app-features.ts). Only where the route takes its role list from the
    // controller: a route with its own @Roles() — the admin-only writes inside
    // a feature — stays exactly as strict as it says.
    const feature = this.reflector.getAllAndOverride<AppFeature | undefined>(FEATURE_KEY, [context.getHandler(), context.getClass()]);
    const routeHasOwnRoles = !!this.reflector.get<string[] | undefined>(ROLES_KEY, context.getHandler());
    if (feature && !routeHasOwnRoles && isAiRoleAccount(userRoles) && user?.features?.includes(feature)) return true;

    throw new ForbiddenException('Insufficient role');
  }
}
