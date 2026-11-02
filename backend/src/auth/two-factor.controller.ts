import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequireSessionAuthGuard } from '../common/guards/require-session-auth.guard';
import { JwtPayload, loginIdOf } from './jwt-payload.interface';
import { TwoFactorVerifyDto } from './dto/two-factor-verify.dto';
import { TwoFactorReauthDto } from './dto/two-factor-reauth.dto';
import { TwoFactorLoginVerifyDto } from './dto/two-factor-login-verify.dto';
import { TwoFactorService } from './two-factor.service';

// Same ceiling as AuthController's own AUTH_THROTTLE — every route here is
// either a guessable-code target (enable/login-verify) or a security-
// settings mutation, both classes this app already rate-limits tighter
// than the app-wide default.
const TWO_FACTOR_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

@Controller('auth/2fa')
export class TwoFactorController {
  constructor(private twoFactorService: TwoFactorService) {}

  @UseGuards(JwtAuthGuard)
  @Get('status')
  getStatus(@CurrentUser() user: JwtPayload) {
    return this.twoFactorService.getStatus(loginIdOf(user));
  }

  // RequireSessionAuthGuard here (and on enable below) — not just
  // disable/regenerate: a leaked/scripted API token being able to complete
  // setup+enable would let it silently turn on 2FA with an attacker-chosen
  // secret, locking the real owner out of their own account at their next
  // password login. Enabling 2FA is exactly the kind of security-state
  // change this guard exists to block a PAT from making.
  @UseGuards(JwtAuthGuard, RequireSessionAuthGuard)
  @Throttle(TWO_FACTOR_THROTTLE)
  @Post('setup')
  setup(@CurrentUser() user: JwtPayload) {
    return this.twoFactorService.setup(loginIdOf(user));
  }

  @UseGuards(JwtAuthGuard, RequireSessionAuthGuard)
  @Throttle(TWO_FACTOR_THROTTLE)
  @Post('enable')
  enable(@CurrentUser() user: JwtPayload, @Body() dto: TwoFactorVerifyDto, @Req() req: Request) {
    return this.twoFactorService.enable(loginIdOf(user), dto.code, req.ip);
  }

  @UseGuards(JwtAuthGuard, RequireSessionAuthGuard)
  @Throttle(TWO_FACTOR_THROTTLE)
  @Post('disable')
  async disable(@CurrentUser() user: JwtPayload, @Body() dto: TwoFactorReauthDto, @Req() req: Request) {
    await this.twoFactorService.disable(loginIdOf(user), dto, user.jti!, req.ip);
    return { success: true };
  }

  @UseGuards(JwtAuthGuard, RequireSessionAuthGuard)
  @Throttle(TWO_FACTOR_THROTTLE)
  @Post('backup-codes/regenerate')
  regenerateBackupCodes(@CurrentUser() user: JwtPayload, @Body() dto: TwoFactorReauthDto, @Req() req: Request) {
    return this.twoFactorService.regenerateBackupCodes(loginIdOf(user), dto, req.ip);
  }

  // Deliberately unguarded — no session exists yet at this point in the
  // login flow, only the short-lived challengeToken from the initial
  // login/OAuth-callback response (see AuthService.issueTokenOrChallenge).
  @Throttle(TWO_FACTOR_THROTTLE)
  @Post('login-verify')
  verifyLoginChallenge(@Body() dto: TwoFactorLoginVerifyDto, @Req() req: Request) {
    return this.twoFactorService.verifyLoginChallenge(dto.challengeToken, dto.code, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
  }
}
