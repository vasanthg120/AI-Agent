import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { BillingAdminCurrenciesService } from './billing-admin-currencies.service';
import { CreateCurrencyDto } from './dto/create-currency.dto';
import { UpdateCurrencyDto } from './dto/update-currency.dto';

// Phase 1 catalog admin surface — platform_admin only, matching every other
// billing-admin-*.controller.ts's gate (global catalog, not one customer's
// data). Nothing here is reachable by a customer-scoped route yet.
@UseGuards(AdminJwtAuthGuard)
@Controller('billing/admin/currencies')
export class BillingAdminCurrenciesController {
  constructor(private currenciesService: BillingAdminCurrenciesService) {}

  @Get()
  list() {
    return this.currenciesService.listCurrencies();
  }

  @Post()
  create(@Body() dto: CreateCurrencyDto) {
    return this.currenciesService.createCurrency(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCurrencyDto) {
    return this.currenciesService.updateCurrency(id, dto);
  }

  @Post(':id/activate')
  activate(@Param('id') id: string) {
    return this.currenciesService.setActive(id, true);
  }

  @Post(':id/deactivate')
  deactivate(@Param('id') id: string) {
    return this.currenciesService.setActive(id, false);
  }
}
