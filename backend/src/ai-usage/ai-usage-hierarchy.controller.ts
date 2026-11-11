import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { PermissionExempt } from '../common/permissions/permission.decorator';
import { AiUsageHierarchyService } from './ai-usage-hierarchy.service';

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

// Provider-agnostic hierarchical AI usage analytics (Platform -> Organisation
// -> User -> Request -> Generation) — deliberately a separate controller
// from ai-usage-admin.controller.ts's `ai-usage/admin/anthropic/*` routes
// (that one is Anthropic-budget-tracking specific and untouched by this
// work; this one covers every provider agent_executions ever records). Same
// platform-admin-only guard tier.
@UseGuards(AdminJwtAuthGuard)
@PermissionExempt('platform')
@Controller('ai-usage/admin')
export class AiUsageHierarchyController {
  constructor(private service: AiUsageHierarchyService) {}

  @Get('overview')
  overview(@Query('days') days?: string) {
    return this.service.getPlatformOverview(parseDays(days));
  }

  // Route order matters: 'overview'/'organizations'/'export' are static
  // segments and must be registered before 'organizations/:organizationId',
  // same rule deals.controller.ts's own comment documents.
  @Get('organizations')
  organizations(@Query('days') days?: string, @Query('search') search?: string) {
    return this.service.getOrganizationsList(parseDays(days), search);
  }

  @Get('organizations/:organizationId')
  organizationDetail(@Param('organizationId') organizationId: string, @Query('days') days?: string) {
    return this.service.getOrganizationDetail(organizationId, parseDays(days));
  }

  @Get('organizations/:organizationId/users/:userId')
  userDetail(
    @Param('organizationId') organizationId: string,
    @Param('userId') userId: string,
    @Query('days') days?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.getUserDetail(organizationId, userId, parseDays(days), {
      page: parsePage(page, 1, 100_000),
      pageSize: parsePage(pageSize, 25, 100),
    });
  }

  @Get('organizations/:organizationId/users/:userId/requests/:requestId')
  requestDetail(@Param('requestId') requestId: string) {
    return this.service.getRequestDetail(requestId);
  }

  @Get('export')
  async export(@Query('organizationId') organizationId: string | undefined, @Query('userId') userId: string | undefined, @Query('days') days: string | undefined, @Res() res: Response) {
    const { csv, filename } = await this.service.exportCsv({ organizationId, userId }, parseDays(days));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` });
    res.send(csv);
  }
}
