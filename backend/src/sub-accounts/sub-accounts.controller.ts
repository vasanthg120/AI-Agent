import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequireSessionAuthGuard } from '../common/guards/require-session-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { ArchiveSubAccountDto, CreateSubAccountDto, GrantAccessDto, SetSubAccountStatusDto, SwitchAccountDto, UpdateSubAccountDto } from './dto/sub-account.dto';
import { SubAccountsService } from './sub-accounts.service';

// The header's account switcher: open to anyone signed in, and it only ever shows
// or enters businesses this login belongs to. Beside OrganizationsController on the
// same path because AuthModule (needed here) already depends on OrganizationsModule.
@UseGuards(JwtAuthGuard)
@Controller('organizations')
export class AccountsController {
  constructor(
    private subAccounts: SubAccountsService,
    private auth: AuthService,
  ) {}

  @Get('accounts')
  accounts(@CurrentUser() user: JwtPayload) {
    return this.subAccounts.listAccounts(user);
  }

  // API tokens can't move between businesses: a token belongs to one.
  @UseGuards(RequireSessionAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('switch')
  switchAccount(@CurrentUser() user: JwtPayload, @Body() dto: SwitchAccountDto, @Req() req: Request) {
    return this.auth.switchAccount(user, dto.organizationId, req.ip);
  }
}

// Owner-only, and SubAccountsService also requires this to be a Main Account (so a
// sub-account's own owner, who holds the same role, is refused there).
@UseGuards(JwtAuthGuard, RequireSessionAuthGuard, RolesGuard)
@Roles('owner')
@Controller('sub-accounts')
export class SubAccountsController {
  constructor(private subAccounts: SubAccountsService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.subAccounts.list(user);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post()
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateSubAccountDto) {
    return this.subAccounts.create(user, dto);
  }

  @Get(':id')
  details(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.subAccounts.details(user, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateSubAccountDto) {
    return this.subAccounts.update(user, id, dto);
  }

  @Post(':id/status')
  setStatus(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: SetSubAccountStatusDto) {
    return this.subAccounts.setStatus(user, id, dto.status);
  }

  @Post(':id/archive')
  archive(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: ArchiveSubAccountDto) {
    return this.subAccounts.archive(user, id, dto.confirmName);
  }

  @Post(':id/restore')
  restore(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.subAccounts.restore(user, id);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/resend-invitation')
  resendInvitation(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.subAccounts.resendInvitation(user, id);
  }

  @Get(':id/users')
  users(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.subAccounts.usersSummary(user, id);
  }

  @Get(':id/grantable-employees')
  grantableEmployees(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.subAccounts.grantableEmployees(user, id);
  }

  @Post(':id/access')
  grantAccess(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: GrantAccessDto) {
    return this.subAccounts.grantAccess(user, id, dto);
  }

  @Delete(':id/access/:userId')
  removeAccess(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('userId') userId: string) {
    return this.subAccounts.removeAccess(user, id, userId);
  }

  @Get(':id/billing')
  billing(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.subAccounts.billingDetails(user, id);
  }

  @Get(':id/integrations')
  integrations(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.subAccounts.integrations(user, id);
  }

  @Get(':id/activity')
  activity(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.subAccounts.activity(user, id);
  }
}
