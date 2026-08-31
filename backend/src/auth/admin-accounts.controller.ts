import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentAdmin } from '../common/decorators/current-admin.decorator';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminAuthService } from './admin-auth.service';
import { AdminJwtPayload } from './admin-jwt-payload.interface';
import { CreateAdminAccountDto } from './dto/create-admin-account.dto';

// Replaces the old cross-org "promote an existing customer" flow
// (users/admin-users.controller.ts) — admin accounts are now their own
// credential, so the only way in is being created here by an existing admin.
@UseGuards(AdminJwtAuthGuard)
@Controller('auth/admin/accounts')
export class AdminAccountsController {
  constructor(private adminAuthService: AdminAuthService) {}

  @Get()
  list() {
    return this.adminAuthService.list();
  }

  @Post()
  create(@Body() dto: CreateAdminAccountDto) {
    return this.adminAuthService.create(dto);
  }

  @Post(':id/activate')
  activate(@Param('id') id: string, @CurrentAdmin() caller: AdminJwtPayload) {
    return this.adminAuthService.setActive(id, true, caller.sub);
  }

  @Post(':id/deactivate')
  deactivate(@Param('id') id: string, @CurrentAdmin() caller: AdminJwtPayload) {
    return this.adminAuthService.setActive(id, false, caller.sub);
  }
}
