import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequireSessionAuthGuard } from '../common/guards/require-session-auth.guard';
import { JwtPayload, loginIdOf } from '../auth/jwt-payload.interface';
import { SessionsService } from './sessions.service';
import { PermissionExempt } from '../common/permissions/permission.decorator';

// Outside /auth — no credential ever appears in these request bodies, so
// there's no reason to dodge AuditInterceptor's /auth skip (see its own
// comment); every mutating route here is automatically audit-logged for
// free with zero extra code.
@PermissionExempt('personal')
@Controller('sessions')
@UseGuards(JwtAuthGuard)
export class SessionsController {
  constructor(private sessionsService: SessionsService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.sessionsService.list(loginIdOf(user), user.jti!);
  }

  @UseGuards(RequireSessionAuthGuard)
  @Post(':jti/revoke')
  async revoke(@CurrentUser() user: JwtPayload, @Param('jti') jti: string) {
    await this.sessionsService.revoke(loginIdOf(user), jti, user.jti!);
    return { success: true };
  }

  @UseGuards(RequireSessionAuthGuard)
  @Post('revoke-all-others')
  revokeAllOthers(@CurrentUser() user: JwtPayload) {
    return this.sessionsService.revokeAllOthers(loginIdOf(user), user.jti!);
  }
}
