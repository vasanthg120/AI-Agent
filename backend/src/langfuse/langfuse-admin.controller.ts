import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { PermissionExempt } from '../common/permissions/permission.decorator';
import { SaveLangfuseConfigDto } from './dto/save-langfuse-config.dto';
import { LangfuseConfigService } from './langfuse-config.service';

// Same AdminJwtAuthGuard + @PermissionExempt('platform') tier as
// admin-integrations.controller.ts — an ordinary customer user can never
// reach this controller at all; it's platform-admin-only, same as every
// other "Admin Settings" provider credential route.
@UseGuards(AdminJwtAuthGuard)
@PermissionExempt('platform')
@Controller('langfuse/admin')
export class LangfuseAdminController {
  constructor(private langfuseConfigService: LangfuseConfigService) {}

  @Get('config')
  getConfig() {
    return this.langfuseConfigService.getStatus();
  }

  @Post('config')
  saveConfig(@Body() dto: SaveLangfuseConfigDto) {
    return this.langfuseConfigService.saveConfig(dto);
  }

  @Post('test-connection')
  testConnection() {
    return this.langfuseConfigService.testConnection();
  }

  @Post('enabled')
  setEnabled(@Body('enabled') enabled: boolean) {
    return this.langfuseConfigService.setEnabled(!!enabled);
  }
}
