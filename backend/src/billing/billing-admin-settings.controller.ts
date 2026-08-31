import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { BillingAdminSettingsService } from './billing-admin-settings.service';
import { UpdateBillingSettingsDto } from './dto/update-billing-settings.dto';

@UseGuards(AdminJwtAuthGuard)
@Controller('billing/admin/settings')
export class BillingAdminSettingsController {
  constructor(private settingsService: BillingAdminSettingsService) {}

  @Get()
  get() {
    return this.settingsService.getSettings();
  }

  @Put()
  update(@Body() dto: UpdateBillingSettingsDto) {
    return this.settingsService.updateSettings(dto);
  }
}
