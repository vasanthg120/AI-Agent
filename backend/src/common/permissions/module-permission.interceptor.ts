import { CallHandler, ExecutionContext, ForbiddenException, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { JwtPayload } from '../../auth/jwt-payload.interface';
import { holdsPermission, isNotDelegable, isPermissionManaged, permissionDeniedMessage, routePermission } from './permission.decorator';

// Holds a person with their own permission list to it on every route that belongs
// to a module — including routes every ordinary account may use, which no role
// check covers. A global interceptor rather than a guard because guards decide who
// someone is: this runs right after them, so request.user is known (same as
// SubscriptionLockInterceptor). RolesGuard and FeatureGuard apply the same rule
// where they run, so neither check depends on the other being there.
//
// Owners, admins and older accounts without a permission list pass untouched.
@Injectable()
export class ModulePermissionInterceptor implements NestInterceptor {
  constructor(private reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const user = context.switchToHttp().getRequest().user as JwtPayload | undefined;
    if (!isPermissionManaged(user)) return next.handle();
    const need = routePermission(this.reflector, context);
    if (!need) return next.handle();
    if (isNotDelegable(this.reflector, context)) throw new ForbiddenException('Only owners and admins can do this.');
    if (!holdsPermission(user, need.module, need.action)) throw new ForbiddenException(permissionDeniedMessage(need));
    return next.handle();
  }
}
