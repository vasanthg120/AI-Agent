import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequireSessionAuthGuard } from '../common/guards/require-session-auth.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ApiTokensService } from './api-tokens.service';
import { CreateApiTokenDto } from './dto/create-api-token.dto';
import { PermissionExempt } from '../common/permissions/permission.decorator';

const API_TOKEN_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

// RequireSessionAuthGuard on every route here, not just creation — an API
// token must never be usable to list/create/revoke API tokens (including
// itself or a sibling token), same "can't escalate its own reach" principle
// as it being blocked from 2FA/session management. Outside /auth — no
// credential appears in these request bodies, so this gets free auto-audit
// coverage from the existing global AuditInterceptor.
@PermissionExempt('personal')
@Controller('api-tokens')
@UseGuards(JwtAuthGuard, RequireSessionAuthGuard)
export class ApiTokensController {
  constructor(private apiTokensService: ApiTokensService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.apiTokensService.list(user.sub);
  }

  @Throttle(API_TOKEN_THROTTLE)
  @Post()
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateApiTokenDto) {
    return this.apiTokensService.create(user.sub, user.organizationId, dto.name, dto.expiresInDays);
  }

  @Delete(':id')
  async revoke(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    await this.apiTokensService.revoke(user.sub, id);
    return { success: true };
  }
}
