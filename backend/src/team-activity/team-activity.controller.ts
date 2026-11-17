import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { Permission } from '../common/permissions/permission.decorator';
import { TeamActivityListQueryDto, TeamActivityQueryDto } from './dto/team-activity-query.dto';
import { TeamActivityService } from './team-activity.service';
import { TeamScopeService } from './team-scope.service';

// Agent Activity and the Dashboard's Team Performance. Whose figures come back
// is decided on the server from the caller alone (TeamScopeService), never from
// what the page asks for: a business or person outside it is refused.
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
    return this.activity.overview(user, { ...query, period: query.period ?? 'today' });
  }

  /** Day by day (week by week for long ranges): calls, talk time, emails sent and answered, deals created and won. */
  @Get('trend')
  trend(@CurrentUser() user: JwtPayload, @Query() query: TeamActivityQueryDto) {
    return this.activity.trend(user, { ...query, period: query.period ?? 'last7' });
  }

  /** The calls, emails or deals behind one number — for one person, or everyone visible. */
  @Get('list')
  list(@CurrentUser() user: JwtPayload, @Query() query: TeamActivityListQueryDto) {
    return this.activity.list(user, query.kind, { ...query, period: query.period ?? 'today' });
  }
}
