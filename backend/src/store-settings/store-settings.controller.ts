import { Body, Controller, Get, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { UpdateStoreSettingsDto } from './dto/update-store-settings.dto';
import { StoreSettingsService } from './store-settings.service';
import { Permission } from '../common/permissions/permission.decorator';

@UseGuards(JwtAuthGuard)
@Permission('settings')
@Controller('store-settings')
export class StoreSettingsController {
  constructor(private storeSettingsService: StoreSettingsService) {}

  @Get()
  get(@CurrentUser() user: JwtPayload) {
    return this.storeSettingsService.getSettings(user);
  }

  // Store operating hours affect every user's scheduled reports in that
  // store — previously reachable by any authenticated user regardless of
  // role, same gap class as agent-roles/integrations below.
  @Put()
  @UseGuards(RolesGuard)
  @Roles('admin')
  update(@CurrentUser() user: JwtPayload, @Body() dto: UpdateStoreSettingsDto) {
    return this.storeSettingsService.updateSettings(user, dto);
  }

  // Manual trigger for testing/ops — waiting for a real opening/closing
  // time to verify the scheduled job is impractical, so this is a real,
  // permanent hook, not a throwaway. Scoped to the caller's own store.
  @Post('run-now')
  @UseGuards(RolesGuard)
  @Roles('admin')
  runNow(@CurrentUser() user: JwtPayload, @Query('type') type: string) {
    return this.storeSettingsService.runNow(user, type === 'eod' ? 'eod' : 'morning');
  }
}
