import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { Permission } from '../common/permissions/permission.decorator';
import { DealActionDto, DealTaskDoneDto } from './dto/deal-action.dto';
import { DealInsightService } from './deal-insight.service';

// The deal panel opened from the Dashboard's lists and Agent Activity. Whose
// deals the caller may open is decided by DealInsightService from the caller.
@UseGuards(JwtAuthGuard)
@Permission(['dashboard', 'analytics', 'customers'])
@Controller('deal-insight')
export class DealInsightController {
  constructor(private insight: DealInsightService) {}

  @Get(':dealId')
  overview(@CurrentUser() user: JwtPayload, @Param('dealId') dealId: string) {
    return this.insight.overview(user, dealId);
  }

  // A real, billed AI call — only ever on a click (never when the panel opens).
  // Reading a deal, so whoever may view it may ask (billed to their business).
  @Post(':dealId/analyse')
  @Permission(['dashboard', 'analytics', 'customers'], 'view')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  analyse(@CurrentUser() user: JwtPayload, @Param('dealId') dealId: string) {
    return this.insight.analyse(user, dealId);
  }

  // An action the AI proposed and a person approved: a task, a note, telling
  // the owner, an email draft. Changes HaiVE's records, so it needs edit rights.
  @Post(':dealId/actions')
  @HttpCode(200)
  @Permission('customers', 'edit')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  action(@CurrentUser() user: JwtPayload, @Param('dealId') dealId: string, @Body() dto: DealActionDto) {
    return this.insight.runAction(user, dealId, dto);
  }

  @Patch(':dealId/tasks/:taskId')
  @Permission('customers', 'edit')
  taskDone(@CurrentUser() user: JwtPayload, @Param('dealId') dealId: string, @Param('taskId') taskId: string, @Body() dto: DealTaskDoneDto) {
    return this.insight.setTaskDone(user, dealId, taskId, dto.done);
  }
}
