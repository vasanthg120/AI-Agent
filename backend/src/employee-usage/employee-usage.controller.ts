import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDateString, IsIn, IsInt, IsOptional, Max, Min, ValidateNested } from 'class-validator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionExempt } from '../common/permissions/permission.decorator';
import { EmployeeUsageService } from './employee-usage.service';
import { USAGE_AREAS, UsageArea } from './usage-areas';

export class UsageBeatDto {
  @IsDateString()
  minute: string;

  @IsIn(USAGE_AREAS)
  area: UsageArea;

  @IsInt()
  @Min(1)
  @Max(60)
  seconds: number;
}

export class RecordUsageDto {
  @IsArray()
  @ArrayMaxSize(240)
  @ValidateNested({ each: true })
  @Type(() => UsageBeatDto)
  beats: UsageBeatDto[];

  // The browser's clock when it sent this, to correct the minutes for a clock that is off.
  @IsOptional()
  @IsDateString()
  sentAt?: string;
}

// The browser reporting how long the person signed in was really active in each
// part of HaiVE (frontend hooks/useUsageTracker.ts). Everyone signed in sends
// their own — nobody else's — so no permission list applies; who may read it is
// TeamScopeService's decision (team-activity). Not throttled: one small request a
// minute per open tab, and an office behind one address must not lose its pages
// to it.
@UseGuards(JwtAuthGuard)
@PermissionExempt('personal')
@SkipThrottle()
@Controller('employee-activity')
export class EmployeeUsageController {
  constructor(private usage: EmployeeUsageService) {}

  @Post('usage')
  @HttpCode(200)
  record(@CurrentUser() user: JwtPayload, @Body() dto: RecordUsageDto) {
    return this.usage.record(user, dto);
  }
}
