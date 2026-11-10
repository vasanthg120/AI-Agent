import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ListTimelineQueryDto } from './dto/list-timeline-query.dto';
import { TimelineService } from './timeline.service';
import { PermissionExempt } from '../common/permissions/permission.decorator';

// Same canOverride/storeConstraint pattern as customer-activity.controller.ts
// — storeId/userId used to be taken straight from the client with no role
// check at all, letting any authenticated caller (including a consultant)
// read another store's or another user's events by just passing the query
// param.
@UseGuards(JwtAuthGuard)
@PermissionExempt('personal')
@Controller('timeline')
export class TimelineController {
  constructor(private timelineService: TimelineService) {}

  // Team members (agent_user) see only their own events, like a consultant.
  @Get()
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin', 'manager', 'consultant', 'agent_user')
  list(@CurrentUser() user: JwtPayload, @Query() query: ListTimelineQueryDto) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeId = canOverride ? query.storeId : user.roles.includes('manager') ? user.storeId : undefined;
    const userId = canOverride ? query.userId : user.roles.includes('manager') ? undefined : user.sub;

    return this.timelineService.list(user.organizationId, {
      storeId,
      userId,
      type: query.type,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      limit: query.limit,
    });
  }
}
