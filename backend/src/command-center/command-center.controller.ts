import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CommandCenterService } from './command-center.service';
import { ListExecutionsQueryDto } from './dto/list-executions-query.dto';
import { Permission } from '../common/permissions/permission.decorator';

@UseGuards(JwtAuthGuard)
@Permission('analytics')
@Controller('command-center')
export class CommandCenterController {
  constructor(private commandCenterService: CommandCenterService) {}

  // Cost/token/error data across the whole org — admin-only, per the spec's
  // "Administrators should monitor every AI Agent from one location."
  @Get('summary')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  summary(@CurrentUser() user: JwtPayload, @Query('days') days?: string) {
    const parsedDays = days ? Number.parseInt(days, 10) : undefined;
    return this.commandCenterService.getSummary(user.organizationId, parsedDays);
  }

  @Get('executions')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  executions(@CurrentUser() user: JwtPayload, @Query() query: ListExecutionsQueryDto) {
    return this.commandCenterService.listExecutions(user.organizationId, query);
  }

  // Not admin-gated — any authenticated user can see their own conversation's
  // stats (powers RightPanel.tsx), scoped by both organizationId and the
  // caller's own userId so one user can never pull another's conversation
  // stats by guessing a conversationId.
  @Get('conversations/:conversationId/stats')
  @Permission('ai_agent', 'view')
  conversationStats(@CurrentUser() user: JwtPayload, @Param('conversationId') conversationId: string) {
    return this.commandCenterService.getConversationStats(user.organizationId, user.sub, conversationId);
  }
}
