import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { BillingAdminCouponsService } from './billing-admin-coupons.service';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';

// Phase 3 catalog admin surface — platform_admin only, matching every other
// billing-admin-*.controller.ts's gate (global catalog, not one customer's
// data). Nothing here is reachable by a customer-scoped route — customers
// only ever interact with a coupon by submitting its code at checkout (see
// billing.controller.ts's credits/purchase and subscription/checkout routes).
@UseGuards(AdminJwtAuthGuard)
@Controller('billing/admin/coupons')
export class BillingAdminCouponsController {
  constructor(private couponsService: BillingAdminCouponsService) {}

  @Get()
  list() {
    return this.couponsService.listCoupons();
  }

  @Post()
  create(@Body() dto: CreateCouponDto) {
    return this.couponsService.createCoupon(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCouponDto) {
    return this.couponsService.updateCoupon(id, dto);
  }

  @Post(':id/activate')
  activate(@Param('id') id: string) {
    return this.couponsService.setActive(id, true);
  }

  @Post(':id/deactivate')
  deactivate(@Param('id') id: string) {
    return this.couponsService.setActive(id, false);
  }

  @Get(':id/redemptions')
  listRedemptions(@Param('id') id: string) {
    return this.couponsService.listRedemptions(id);
  }
}
