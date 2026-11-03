import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CustomerActivityService } from './customer-activity.service';
import { Permission } from '../common/permissions/permission.decorator';

// RBAC matches the rest of the Deal Performance page (owner/admin/manager),
// same canOverride/storeConstraint pattern deals.controller.ts already uses
// — a manager is always forced to their own store, never a client-supplied one.
@UseGuards(JwtAuthGuard)
@Permission('customers')
@Controller('crm/customer-activity')
export class CustomerActivityController {
  constructor(private customerActivityService: CustomerActivityService) {}

  @Get('overview')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin', 'manager')
  overview(@CurrentUser() user: JwtPayload, @Query('storeId') storeIdOverride?: string) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? storeIdOverride : user.storeId;
    return this.customerActivityService.getOverview(user, storeConstraint);
  }

  // Phase 19 — Unified Analytics Dashboard's Customers & Email tab. One
  // endpoint, internal role branching (including consultant, unlike
  // `overview` above which predates the dashboard needing a consultant-
  // reachable path) — takes a raw from/to day range so this always shares
  // the exact same window as the Email Activity widget's own filter,
  // instead of one being month-scoped and the other day-scoped.
  @Get('breakdown-stats')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin', 'manager', 'consultant')
  breakdownStats(@CurrentUser() user: JwtPayload, @Query('from') from: string, @Query('to') to: string) {
    if (!from || !to) throw new BadRequestException('from and to are required');
    const start = new Date(from);
    // Explicit 'Z' (UTC) end-of-day — `.setHours()` mutates in the server
    // process's local timezone, which drifts hours off this boundary on any
    // server not running in UTC.
    const end = new Date(`${to}T23:59:59.999Z`);
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    if (canOverride) {
      return this.customerActivityService.getCustomerBreakdownForRange(user.organizationId, start, end);
    }
    if (user.roles.includes('manager')) {
      if (!user.storeId) throw new BadRequestException('No store assigned to this account');
      return this.customerActivityService.getCustomerBreakdownForRange(user.organizationId, start, end, user.storeId);
    }
    return this.customerActivityService.getCustomerBreakdownForRange(user.organizationId, start, end, undefined, user.sub);
  }

  @Post('generate-summary')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin', 'manager')
  @Permission('customers', 'view')
  generateSummary(@CurrentUser() user: JwtPayload, @Body() body: { regenerate?: boolean }) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? undefined : user.storeId;
    return this.customerActivityService.generateSummary(user, storeConstraint, body?.regenerate ?? false);
  }

  // Consultant-only, always self-scoped via the caller's own JWT — no
  // owner/admin override to view a specific consultant's feed (matches
  // GET /crm/dashboard/consultant's existing precedent).
  @Get('personal-overview')
  @UseGuards(RolesGuard)
  @Roles('consultant')
  personalOverview(@CurrentUser() user: JwtPayload) {
    return this.customerActivityService.getPersonalOverview(user);
  }

  @Post('generate-personal-summary')
  @UseGuards(RolesGuard)
  @Roles('consultant')
  @Permission('customers', 'view')
  generatePersonalSummary(@CurrentUser() user: JwtPayload, @Body() body: { regenerate?: boolean }) {
    return this.customerActivityService.generatePersonalSummary(user, body?.regenerate ?? false);
  }

  // Phase 14a relationship view — same RBAC/store-scoping pattern as
  // `overview` above. businessKey is a Deal.accountId or a normalized
  // heuristic/email-derived string (see customer-grouping.util.ts) — the
  // frontend must encodeURIComponent it since it can contain arbitrary
  // characters (spaces, "@", ":").
  @Get('relationships/:businessKey')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin', 'manager')
  relationships(@CurrentUser() user: JwtPayload, @Param('businessKey') businessKey: string, @Query('storeId') storeIdOverride?: string) {
    const canOverride = user.roles.includes('admin') || user.roles.includes('owner');
    const storeConstraint = canOverride ? storeIdOverride : user.storeId;
    return this.customerActivityService.getRelationshipView(user, businessKey, storeConstraint);
  }

  // Consultant-only, always self-scoped — mirrors personal-overview above.
  @Get('personal-relationships/:businessKey')
  @UseGuards(RolesGuard)
  @Roles('consultant')
  personalRelationships(@CurrentUser() user: JwtPayload, @Param('businessKey') businessKey: string) {
    return this.customerActivityService.getPersonalRelationshipView(user, businessKey);
  }
}
