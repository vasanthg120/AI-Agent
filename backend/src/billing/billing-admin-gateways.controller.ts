import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { BillingAdminGatewaysService } from './billing-admin-gateways.service';
import { UpsertBillingGatewayConfigDto } from './dto/upsert-billing-gateway-config.dto';
import { PaymentProviderKey } from './providers/payment-provider.interface';

// Phase 8 (optional) admin surface — platform_admin only, matching every
// other billing-admin-*.controller.ts's gate. The most sensitive route in
// this entire module (accepts raw gateway secrets), and correspondingly the
// only one whose GET response is deliberately never the raw request body
// shape — see BillingAdminGatewaysService.toStatus.
@UseGuards(AdminJwtAuthGuard)
@Controller('billing/admin/gateways')
export class BillingAdminGatewaysController {
  constructor(private gatewaysService: BillingAdminGatewaysService) {}

  @Get()
  list() {
    return this.gatewaysService.list();
  }

  @Post()
  upsert(@Body() dto: UpsertBillingGatewayConfigDto) {
    return this.gatewaysService.upsert(dto.provider, dto.mode, dto.credentials);
  }

  @Post(':provider/:mode/activate')
  activate(@Param('provider') provider: PaymentProviderKey, @Param('mode') mode: 'live' | 'test') {
    return this.gatewaysService.setActive(provider, mode, true);
  }

  @Post(':provider/:mode/deactivate')
  deactivate(@Param('provider') provider: PaymentProviderKey, @Param('mode') mode: 'live' | 'test') {
    return this.gatewaysService.setActive(provider, mode, false);
  }
}
