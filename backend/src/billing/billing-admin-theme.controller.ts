import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { BillingThemeService } from './billing-theme.service';
import { UpdateBillingThemeDto } from './dto/update-billing-theme.dto';

@UseGuards(AdminJwtAuthGuard)
@Controller('billing/admin/theme')
export class BillingAdminThemeController {
  constructor(private themeService: BillingThemeService) {}

  @Get()
  get() {
    return this.themeService.getTheme();
  }

  @Put()
  update(@Body() dto: UpdateBillingThemeDto) {
    return this.themeService.updateTheme(dto);
  }
}
