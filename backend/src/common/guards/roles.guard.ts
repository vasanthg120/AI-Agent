import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtPayload } from '../../auth/jwt-payload.interface';
import { AppFeature, FEATURE_KEY, isAiRoleAccount } from '../app-features';
import { ROLES_KEY } from '../decorators/roles.decorator';

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
