import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { BillingAdminProviderPricingService } from './billing-admin-provider-pricing.service';
import { CreateProviderPricingDto } from './dto/create-provider-pricing.dto';

@UseGuards(AdminJwtAuthGuard)
@Controller('billing/admin/provider-pricing')
export class BillingAdminProviderPricingController {
  constructor(private pricingService: BillingAdminProviderPricingService) {}

  @Get()
  list() {
    return this.pricingService.list();
  }

  @Post()
  create(@Body() dto: CreateProviderPricingDto) {
    return this.pricingService.create(dto);
  }
}
