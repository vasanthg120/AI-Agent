import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { BillingAdminEntitlementsService } from './billing-admin-entitlements.service';
import { CreateEntitlementDto } from './dto/create-entitlement.dto';
import { UpdateEntitlementDto } from './dto/update-entitlement.dto';

// Admin-haive's "Entitlements" catalog page — platform_admin only, matching
// every other billing-admin-*.controller.ts's gate. Phase 0 of the
// ChatGPT-style billing migration (see entitlements.service.ts); reachable
// from no customer-scoped route.
@UseGuards(AdminJwtAuthGuard)
@Controller('billing/admin/entitlements')
export class BillingAdminEntitlementsController {
  constructor(private entitlementsService: BillingAdminEntitlementsService) {}

  @Get()
  list() {
    return this.entitlementsService.listEntitlements();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.entitlementsService.getEntitlement(id);
  }

  @Post()
  create(@Body() dto: CreateEntitlementDto) {
    return this.entitlementsService.createEntitlement(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateEntitlementDto) {
    return this.entitlementsService.updateEntitlement(id, dto);
  }

  @Post(':id/activate')
  activate(@Param('id') id: string) {
    return this.entitlementsService.setActive(id, true);
  }

  @Post(':id/deactivate')
  deactivate(@Param('id') id: string) {
    return this.entitlementsService.setActive(id, false);
  }
}
