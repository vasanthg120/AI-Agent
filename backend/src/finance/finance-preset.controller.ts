import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { UpsertFinancePresetDto } from './dto/upsert-finance-preset.dto';
import { FinancePresetService } from './finance-preset.service';
import { Permission } from '../common/permissions/permission.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'admin')
@Permission('finance')
@Controller('finance/presets')
export class FinancePresetController {
  constructor(private presetService: FinancePresetService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.presetService.list(user.organizationId, user.sub);
  }

  @Post()
  create(@CurrentUser() user: JwtPayload, @Body() dto: UpsertFinancePresetDto) {
    return this.presetService.create(user.organizationId, user.sub, dto);
  }

  @Patch(':id')
  update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpsertFinancePresetDto) {
    return this.presetService.update(id, user.organizationId, user.sub, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.presetService.remove(id, user.organizationId, user.sub);
  }
}
