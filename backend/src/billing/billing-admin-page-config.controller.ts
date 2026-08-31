import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { BillingPageConfigService } from './billing-page-config.service';
import { UpdateBillingPageConfigDto } from './dto/update-billing-page-config.dto';

@UseGuards(AdminJwtAuthGuard)
@Controller('billing/admin/page-config')
export class BillingAdminPageConfigController {
  constructor(private pageConfigService: BillingPageConfigService) {}

  @Get()
  get() {
    return this.pageConfigService.getPageConfig();
  }

  @Put()
  update(@Body() dto: UpdateBillingPageConfigDto) {
    return this.pageConfigService.updatePageConfig(dto);
  }
}
