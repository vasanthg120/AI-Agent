import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AdminJwtPayload } from '../../auth/admin-jwt-payload.interface';

// Mirrors CurrentUser exactly, typed for AdminJwtPayload instead of
// JwtPayload — only valid on routes gated by AdminJwtAuthGuard.
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AdminJwtPayload => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
