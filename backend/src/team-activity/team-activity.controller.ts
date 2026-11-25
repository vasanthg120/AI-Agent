import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { Permission } from '../common/permissions/permission.decorator';
import { TeamActivityListQueryDto, TeamActivityQueryDto } from './dto/team-activity-query.dto';
import { TeamActivityService } from './team-activity.service';
import { TeamScopeService } from './team-scope.service';

// Employee Activity (formerly Agent Activity) and the Dashboard's Team
// Performance. Whose figures come back is decided on the server from the caller
// alone (TeamScopeService), never from what the page asks for: a business or
// person outside it is refused. Figures may be up to 30 seconds old (the
// answer says when it was worked out: generatedAt).
@UseGuards(JwtAuthGuard)
@Permission(['dashboard', 'analytics'])
@Controller('team-activity')
export class TeamActivityController {
  constructor(
    private activity: TeamActivityService,
    private scopes: TeamScopeService,
  ) {}

  /** The businesses the caller may look at, and whether they see the team or only themselves. */
  @Get('scope')
  async scope(@CurrentUser() user: JwtPayload) {
    const scope = await this.scopes.resolve(user);
    return { team: scope.team, acrossBusinesses: scope.acrossBusinesses, businesses: scope.businesses };
  }

  @Get('overview')
  overview(@CurrentUser() user: JwtPayload, @Query() query: TeamActivityQueryDto) {
    const q = { ...query, period: query.period ?? 'today', compare: query.compare === 'true' };
    return this.activity.cached('overview', user, q, () => this.activity.overview(user, q));
  }

  /** Day by day (week by week for long ranges): calls, talk time, emails, deals created / won / lost, measured time. */
  @Get('trend')
  trend(@CurrentUser() user: JwtPayload, @Query() query: TeamActivityQueryDto) {
    const q = { ...query, period: query.period ?? 'last7', compare: false };
    return this.activity.cached('trend', user, q, () => this.activity.trend(user, q));
  }

  /** Measured time in HaiVE and on calls, the other apps people work in, and (for one person) sessions and sign-ins. */
  @Get('usage')
  usage(@CurrentUser() user: JwtPayload, @Query() query: TeamActivityQueryDto) {
    const q = { ...query, period: query.period ?? 'today', compare: false };
    return this.activity.cached('usage', user, q, () => this.activity.usage(user, q));
  }

  /** The calls, emails or deals behind one number — for one person, or everyone visible. */
  @Get('list')
  list(@CurrentUser() user: JwtPayload, @Query() query: TeamActivityListQueryDto) {
    return this.activity.list(user, query.kind, { ...query, period: query.period ?? 'today', compare: false });
  }
}
