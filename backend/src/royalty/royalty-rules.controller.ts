import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CreateRoyaltyRuleDto } from './dto/create-royalty-rule.dto';
import { UpdateRoyaltyRuleDto } from './dto/update-royalty-rule.dto';
import { RoyaltyRulesService } from './royalty-rules.service';
import { Permission } from '../common/permissions/permission.decorator';

// Tighter tier than InvoicesController (owner/admin only, no manager) —
// matches Finance's/Command Center's precedent: sensitive, org-wide
// financial configuration (the actual royalty percentage/cap agreement)
// gets the tighter gate, unlike routine store-operational Invoice CRUD.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'admin')
@Permission('settings')
@Controller('royalty/rules')
export class RoyaltyRulesController {
  constructor(private royaltyRulesService: RoyaltyRulesService) {}

  @Get('current')
  getCurrent(@CurrentUser() user: JwtPayload) {
    return this.royaltyRulesService.getCurrentRule(user.organizationId);
  }

  @Get('history')
  listHistory(@CurrentUser() user: JwtPayload) {
    return this.royaltyRulesService.listHistory(user.organizationId);
  }

  @Post()
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateRoyaltyRuleDto) {
    return this.royaltyRulesService.createVersion(user.organizationId, dto, user.sub);
  }

  @Patch(':id')
  update(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: UpdateRoyaltyRuleDto) {
    return this.royaltyRulesService.updateFutureVersion(id, user.organizationId, dto);
  }
}
