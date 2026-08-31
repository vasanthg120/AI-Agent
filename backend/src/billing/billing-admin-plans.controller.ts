import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { BillingAdminPlansService } from './billing-admin-plans.service';
import { CreateBillingFeatureDto } from './dto/create-billing-feature.dto';
import { CreateBillingPlanDto } from './dto/create-billing-plan.dto';
import { CreateBillingPlanPriceDto } from './dto/create-billing-plan-price.dto';
import { DuplicateBillingPlanDto } from './dto/duplicate-billing-plan.dto';
import { ReorderBillingPlansDto } from './dto/reorder-billing-plans.dto';
import { UpdateBillingFeatureDto } from './dto/update-billing-feature.dto';
import { UpdateBillingPlanDto } from './dto/update-billing-plan.dto';

// Phase 0 catalog admin surface — platform_admin only, matching
// billing-admin.controller.ts's existing gate (global plan/price/feature
// catalog, not one customer's data). Nothing here is reachable by a
// customer-scoped route yet; that arrives once a future
// GET /billing/plans is added.
@UseGuards(AdminJwtAuthGuard)
@Controller('billing/admin')
export class BillingAdminPlansController {
  constructor(private plansService: BillingAdminPlansService) {}

  @Get('plans')
  listPlans() {
    return this.plansService.listPlans();
  }

  @Get('plans/:id')
  getPlan(@Param('id') id: string) {
    return this.plansService.getPlan(id);
  }

  @Post('plans')
  createPlan(@Body() dto: CreateBillingPlanDto) {
    return this.plansService.createPlan(dto);
  }

  @Patch('plans/:id')
  updatePlan(@Param('id') id: string, @Body() dto: UpdateBillingPlanDto) {
    return this.plansService.updatePlan(id, dto);
  }

  @Post('plans/:id/archive')
  archivePlan(@Param('id') id: string) {
    return this.plansService.archivePlan(id);
  }

  @Post('plans/:id/activate')
  activatePlan(@Param('id') id: string) {
    return this.plansService.activatePlan(id);
  }

  @Post('plans/:id/duplicate')
  duplicatePlan(@Param('id') id: string, @Body() dto: DuplicateBillingPlanDto) {
    return this.plansService.duplicatePlan(id, dto.key);
  }

  @Delete('plans/:id')
  deletePlan(@Param('id') id: string) {
    return this.plansService.deletePlan(id);
  }

  @Post('plans/reorder')
  reorderPlans(@Body() dto: ReorderBillingPlansDto) {
    return this.plansService.reorderPlans(dto.orderedIds);
  }

  @Get('plans/:id/prices')
  listPrices(@Param('id') id: string) {
    return this.plansService.listPrices(id);
  }

  @Post('plans/:id/prices')
  addPrice(@Param('id') id: string, @Body() dto: CreateBillingPlanPriceDto) {
    return this.plansService.addPrice(id, dto);
  }

  @Delete('plan-prices/:priceId')
  removePrice(@Param('priceId') priceId: string) {
    return this.plansService.removePrice(priceId);
  }

  @Get('features')
  listFeatures() {
    return this.plansService.listFeatures();
  }

  @Post('features')
  createFeature(@Body() dto: CreateBillingFeatureDto) {
    return this.plansService.createFeature(dto);
  }

  @Patch('features/:id')
  updateFeature(@Param('id') id: string, @Body() dto: UpdateBillingFeatureDto) {
    return this.plansService.updateFeature(id, dto);
  }
}
