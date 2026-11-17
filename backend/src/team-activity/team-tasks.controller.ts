import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { IsDateString, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { TeamActivityService } from './team-activity.service';

export class GiveTaskDto {
  // The person's business (the Main Account owner gives tasks in any of theirs); the caller's own when left out.
  @IsOptional()
  @IsString()
  organizationId?: string;

  @IsString()
  assigneeId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsIn(['high', 'normal'])
  priority?: 'high' | 'normal';
}

export class MoveTaskDto {
  @IsOptional()
  @IsIn(['todo', 'in_progress', 'done'])
  status?: 'todo' | 'in_progress' | 'done';

  // Their manager only; null clears it.
  @IsOptional()
  @IsDateString()
  dueDate?: string | null;
}

// Tasks given to people: by their manager in Agent Activity, on a customer or a
// job, or by the deal AI — one task system (customer_tasks). Everyone signed in
// may see and move along their own tasks (the To-Do page), whatever pages their
// permissions open; giving a task, or moving someone else's, is checked against
// whose work the caller sees (TeamScopeService) inside TeamActivityService.
@UseGuards(JwtAuthGuard)
@Controller('team-tasks')
export class TeamTasksController {
  constructor(private activity: TeamActivityService) {}

  /** Everything given to me: still to do, and what I finished in the last week. */
  @Get('mine')
  mine(@CurrentUser() user: JwtPayload) {
    return this.activity.myTasks(user);
  }

  @Post()
  give(@CurrentUser() user: JwtPayload, @Body() dto: GiveTaskDto) {
    return this.activity.giveTask(user, dto);
  }

  /** To do → in progress → done (or back); a manager may also change the day it is due. */
  @Patch(':id')
  move(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: MoveTaskDto) {
    return this.activity.moveTask(user, id, dto);
  }
}
