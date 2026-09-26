import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AiUsageAdminService } from './ai-usage-admin.service';
import { SetAnthropicBudgetDto } from './dto/set-anthropic-budget.dto';

function parseDays(raw?: string): number {
  const n = parseInt(raw ?? '30', 10);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(n, 365);
}

function parsePage(raw: string | undefined, fallback: number, max: number): number {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

@UseGuards(AdminJwtAuthGuard)
@Controller('ai-usage/admin/anthropic')
export class AiUsageAdminController {
  constructor(private service: AiUsageAdminService) {}

  @Get('summary')
  summary(@Query('days') days?: string) {
    return this.service.getSummary(parseDays(days));
  }

  @Get('timeseries')
  timeseries(@Query('days') days?: string) {
    return this.service.getTimeseries(parseDays(days));
  }

  @Get('models')
  models(@Query('days') days?: string) {
    return this.service.getModelBreakdown(parseDays(days));
  }

  @Get('organizations')
  organizations(@Query('days') days?: string) {
    return this.service.getOrganizationBreakdown(parseDays(days));
  }

  @Get('requests')
  requests(
    @Query('days') days?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('model') model?: string,
    @Query('organizationId') organizationId?: string,
    @Query('status') status?: 'success' | 'failed',
    @Query('search') search?: string,
  ) {
    return this.service.getRequestHistory({
      days: parseDays(days),
      page: parsePage(page, 1, 100_000),
      pageSize: parsePage(pageSize, 25, 100),
      model,
      organizationId,
      status,
      search,
    });
  }

  // No external provider poll happens here (see AiUsageAdminService's class
  // comment on reconciliation) — Mongo already has fresh data on every
  // insert, so "Refresh" simply re-runs the same aggregation as GET summary.
  // Kept as its own POST route (rather than just re-calling GET from the
  // frontend) so the click is explicit and matches the spec's expected
  // Refresh action shape.
  @Post('refresh')
  refresh(@Query('days') days?: string) {
    return this.service.getSummary(parseDays(days));
  }

  @Post('budget')
  setBudget(@Body() dto: SetAnthropicBudgetDto) {
    return this.service.setBudget(dto);
  }
}
