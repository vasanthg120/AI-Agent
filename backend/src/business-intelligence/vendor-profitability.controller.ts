import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Transform } from 'class-transformer';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { resolveBiDateRange } from './bi-filter.util';
import { BiFilterQueryDto, splitCsv } from './dto/bi-filter-query.dto';
import { VendorProfitabilityService } from './vendor-profitability.service';

class VendorProfitabilityQueryDto extends BiFilterQueryDto {
  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  @IsString({ each: true })
  vendorId?: string[];
}

// Owner/admin only — matches Finance's own existing sensitivity tier, more
// restrictive than every other BI section (margin data is more sensitive
// than pipeline data). No manager/consultant store or self scoping needed:
// this role tier always sees the whole org.
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('business-intelligence/vendor-profitability')
export class VendorProfitabilityController {
  constructor(private vendorProfitabilityService: VendorProfitabilityService) {}

  @Get()
  @Roles('owner', 'admin')
  overview(@CurrentUser() user: JwtPayload, @Query() query: VendorProfitabilityQueryDto) {
    const { start, end } = resolveBiDateRange(query);
    return this.vendorProfitabilityService.getOverview(user.organizationId, start, end, { vendorId: query.vendorId });
  }

  // Section 10 — click a row to see the complete deal (vendor documents,
  // customer quotes, PDF references, AI summary) with no date restriction of
  // its own, since the deal was already selected from the filtered overview.
  @Get('deals/:dealId')
  @Roles('owner', 'admin')
  dealDetail(@CurrentUser() user: JwtPayload, @Param('dealId') dealId: string) {
    return this.vendorProfitabilityService.getDealDetail(user.organizationId, dealId);
  }

  // Re-derives the transaction rows server-side from the same filters
  // (never trusts client-supplied numbers for an AI prompt) before handing
  // them to the LLM — the AI can only ever see real, freshly-computed rows,
  // never a client-fabricated one.
  @Post('ai-compare')
  @Roles('owner', 'admin')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async aiCompare(@CurrentUser() user: JwtPayload, @Query() query: VendorProfitabilityQueryDto) {
    const { start, end } = resolveBiDateRange(query);
    const overview = await this.vendorProfitabilityService.getOverview(user.organizationId, start, end, { vendorId: query.vendorId });
    return this.vendorProfitabilityService.requestAiComparison(user, overview.rows);
  }
}
