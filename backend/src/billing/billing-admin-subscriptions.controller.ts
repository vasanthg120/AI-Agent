import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { BillingSubscriptionsService } from './billing-subscriptions.service';

// Admin-haive Subscriptions page — platform_admin only, matching every other
// admin surface. Cancel/reactivate reuse BillingSubscriptionsService's exact
// customer-facing soft-cancel primitive; renewal logic in
// subscription-renewal.service.ts is untouched.
@UseGuards(AdminJwtAuthGuard)
@Controller('billing/admin/subscriptions')
export class BillingAdminSubscriptionsController {
  constructor(private subscriptionsService: BillingSubscriptionsService) {}

  @Get()
  list(@Query('organizationId') organizationId?: string, @Query('status') status?: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    return this.subscriptionsService.adminList({
      organizationId,
      status,
      page: page ? Number.parseInt(page, 10) : undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.subscriptionsService.adminCancel(id);
  }

  @Post(':id/reactivate')
  reactivate(@Param('id') id: string) {
    return this.subscriptionsService.adminReactivate(id);
  }
}
