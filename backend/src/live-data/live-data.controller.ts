import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Permission } from '../common/permissions/permission.decorator';
import { LiveDataService, LiveScope } from './live-data.service';

const scopeOf = (value: unknown): LiveScope => (value === 'all' ? 'all' : 'business');
const flag = (value: unknown) => value === true || value === 'true' || value === '1';

// Live source data for the pages that show CRM and mailbox data. Any one of those
// pages is enough: it only reads (and says how fresh) what that page already shows.
@UseGuards(JwtAuthGuard)
@Permission(['customers', 'dashboard', 'analytics', 'email', 'reports'], 'view')
@Controller('live')
export class LiveDataController {
  constructor(private live: LiveDataService) {}

  /** A page opened: ask each live source for what changed (in the background), then where each stands. */
  @Post('refresh')
  refresh(@CurrentUser() user: JwtPayload, @Body() body: { scope?: string; email?: boolean; crm?: boolean }) {
    return this.live.refresh(user, { scope: scopeOf(body?.scope), email: flag(body?.email), crm: body?.crm !== false });
  }

  /** Where each source stands — watched by an open page while a read is under way (a cheap database read). */
  @Get('status')
  @SkipThrottle()
  status(@CurrentUser() user: JwtPayload, @Query('scope') scope?: string, @Query('email') email?: string) {
    return this.live.status(user, { scope: scopeOf(scope), email: flag(email) });
  }
}
