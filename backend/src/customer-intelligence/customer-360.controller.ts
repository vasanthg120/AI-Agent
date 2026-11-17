import { Body, Controller, ForbiddenException, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { Feature } from '../common/app-features';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { FeatureGuard } from '../common/guards/feature.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Permission } from '../common/permissions/permission.decorator';
import { HEALTH_COMPONENTS, IntelligenceSettings } from './customer-360';
import { Customer360Service } from './customer-360.service';

export class DecideActionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  key: string;

  @IsIn(['accepted', 'dismissed', 'follow_up', 'open'])
  decision: 'accepted' | 'dismissed' | 'follow_up' | 'open';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  assigneeId?: string;
}

class WeightsDto {
  @IsOptional() @IsInt() @Min(0) @Max(100) engagement?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) purchase?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) payment?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) responsiveness?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) sentiment?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) conversion?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) followUp?: number;
}

export class IntelligenceSettingsDto {
  @IsOptional() @IsInt() @Min(7) @Max(1095) dormantAfterDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(365) newCustomerDays?: number;
  @IsOptional() @IsInt() @Min(2) @Max(50) repeatMinOrders?: number;
  @IsOptional() @IsInt() @Min(1) @Max(50) highValueTopPercent?: number;
  @IsOptional() @IsInt() @Min(1) @Max(60) unansweredRiskDays?: number;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => WeightsDto)
  weights?: WeightsDto;
}

/** "current" in a link means the business the caller is signed in to (the Customers panel links with it). */
const orgOf = (user: JwtPayload, org: string) => (org === 'current' ? user.organizationId : org);

// Customer Intelligence (Customer 360°): search a customer by name, phone,
// email, company, quotation/invoice number, deal or CRM id, then see them whole.
// Same audience as the Customers page it builds on; the Main Account owner may
// search and open the customers of every sub-account (TeamScopeService), each
// business's customers kept apart.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'admin', 'manager')
@Feature('inquiries')
@Permission('customers')
@Controller('customer-intelligence')
export class Customer360Controller {
  constructor(private service: Customer360Service) {}

  @Get('search')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  search(@CurrentUser() user: JwtPayload, @Query('q') q?: string, @Query('org') org?: string) {
    return this.service.search(user, (q ?? '').slice(0, 120), org || undefined);
  }

  @Get('settings')
  getSettings(@CurrentUser() user: JwtPayload, @Query('org') org?: string) {
    return this.service.getSettings(user, org || undefined);
  }

  @Put('settings')
  @Permission('customers', 'edit')
  saveSettings(@CurrentUser() user: JwtPayload, @Body() body: IntelligenceSettingsDto, @Query('org') org?: string) {
    const weights = body.weights ? Object.fromEntries(HEALTH_COMPONENTS.map((k) => [k, body.weights?.[k]]).filter(([, v]) => v !== undefined)) : undefined;
    return this.service.saveSettings(user, org || undefined, { ...body, ...(weights ? { weights } : {}) } as Partial<IntelligenceSettings>);
  }

  @Get(':org/:id')
  profile(@CurrentUser() user: JwtPayload, @Param('org') org: string, @Param('id') id: string) {
    return this.service.profile(user, orgOf(user, org), id);
  }

  // A real, billed AI call — same per-employee switch as the chat.
  @Post(':org/:id/analyze')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Permission('customers', 'view')
  analyze(@CurrentUser() user: JwtPayload, @Param('org') org: string, @Param('id') id: string, @Query('refresh') refresh?: string) {
    if (user.aiAccessEnabled === false) throw new ForbiddenException('AI access has been disabled for your account by an administrator.');
    return this.service.analyze(user, orgOf(user, org), id, refresh === 'true');
  }

  // Accept / dismiss a suggested action, or turn it into a follow-up task. Never sends anything.
  @Post(':org/:id/actions')
  @Permission('customers', 'edit')
  decide(@CurrentUser() user: JwtPayload, @Param('org') org: string, @Param('id') id: string, @Body() body: DecideActionDto) {
    return this.service.decide(user, orgOf(user, org), id, body);
  }
}

// The customer on a call, in a few lines — shown in Call Copilot before and during a
// call. Same audience as Call Copilot; which customers a person may see is decided in
// Customer360Service.snapshot (the Dialer's rule).
@UseGuards(JwtAuthGuard, FeatureGuard)
@Feature('call_copilot')
@Permission('call_copilot')
@Controller('call-copilot/customer-snapshot')
export class CallCustomerSnapshotController {
  constructor(private service: Customer360Service) {}

  @Get()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  snapshot(@CurrentUser() user: JwtPayload, @Query('dealId') dealId?: string, @Query('phone') phone?: string) {
    return this.service.snapshot(user, { dealId: (dealId ?? '').slice(0, 64) || undefined, phone: (phone ?? '').slice(0, 32) || undefined });
  }
}
