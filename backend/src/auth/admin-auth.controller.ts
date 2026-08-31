import { Body, Controller, Post } from '@nestjs/common';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginDto } from './dto/admin-login.dto';

// Mounted separately from AuthController (customer login/register/2FA/OAuth)
// — no shared route prefix, no shared logic. This is the entire surface a
// non-admin credential can reach; everything else under /auth/admin/* is
// gated by AdminJwtAuthGuard (see admin-accounts.controller.ts).
@Controller('auth/admin')
export class AdminAuthController {
  constructor(private adminAuthService: AdminAuthService) {}

  @Post('login')
  login(@Body() dto: AdminLoginDto) {
    return this.adminAuthService.login(dto.email, dto.password);
  }
}
