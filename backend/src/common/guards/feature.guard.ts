import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtPayload } from '../../auth/jwt-payload.interface';
import { AppFeature, FEATURE_KEY, isAiRoleAccount } from '../app-features';

// For features every ordinary account may use (the AI Email Inbox, Call
// Copilot): an account tied to an AI role gets in only when that AI role
// includes the feature. Everyone else passes untouched.
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const feature = this.reflector.getAllAndOverride<AppFeature | undefined>(FEATURE_KEY, [context.getHandler(), context.getClass()]);
    if (!feature) return true;
    const user = context.switchToHttp().getRequest().user as JwtPayload | undefined;
    if (!isAiRoleAccount(user?.roles)) return true;
    if (user?.features?.includes(feature)) return true;
    throw new ForbiddenException('Your AI role doesn’t include this feature. Ask an admin to enable it for the role.');
  }
}
