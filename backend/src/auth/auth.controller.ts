import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { AuthService, SessionMeta } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResendOtpDto } from './dto/resend-otp.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { AcceptInvitationDto, VerifyInvitationDto } from './dto/invitation.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequireSessionAuthGuard } from '../common/guards/require-session-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload, loginIdOf } from './jwt-payload.interface';
import { PermissionExempt } from '../common/permissions/permission.decorator';

// Tighter than the app-wide default (see ThrottlerModule.forRoot in
// app.module.ts) — these are the two routes a credential-stuffing/brute-force
// attempt would actually hit, so they get their own stricter ceiling.
const AUTH_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

function sessionMeta(req: Request): SessionMeta {
  return { userAgent: req.headers['user-agent'], ip: req.ip };
}

@PermissionExempt('personal')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Throttle(AUTH_THROTTLE)
  @Post('register')
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.authService.register(dto.email, dto.password, dto.name, dto.organizationName, sessionMeta(req));
  }

  @Throttle(AUTH_THROTTLE)
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto.email, dto.password, sessionMeta(req));
  }

  @Throttle(AUTH_THROTTLE)
  @Post('verify-otp')
  async verifyOtp(@Body() dto: VerifyOtpDto) {
    await this.authService.verifyEmail(dto.email, dto.otp);
    return { verified: true };
  }

  @Throttle(AUTH_THROTTLE)
  @Post('resend-otp')
  async resendOtp(@Body() dto: ResendOtpDto) {
    await this.authService.resendVerificationOtp(dto.email);
    return { sent: true };
  }

  @Throttle(AUTH_THROTTLE)
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  @Throttle(AUTH_THROTTLE)
  @Post('reset-password')
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.authService.resetPassword(dto.email, dto.otp, dto.password);
    return { success: true };
  }

  // Public, like login: the emailed token is what proves who this is.
  @Throttle(AUTH_THROTTLE)
  @Post('invitation/verify')
  verifyInvitation(@Body() dto: VerifyInvitationDto) {
    return this.authService.describeInvitation(dto.token);
  }

  @Throttle(AUTH_THROTTLE)
  @Post('invitation/accept')
  acceptInvitation(@Body() dto: AcceptInvitationDto, @Req() req: Request) {
    return this.authService.acceptInvitation(dto.token, dto.password, sessionMeta(req));
  }

  @UseGuards(JwtAuthGuard, RequireSessionAuthGuard)
  @Throttle(AUTH_THROTTLE)
  @Post('change-password')
  async changePassword(@CurrentUser() user: JwtPayload, @Body() dto: ChangePasswordDto, @Req() req: Request) {
    // user.jti is always present here — RequireSessionAuthGuard already
    // rejected any request not authenticated via a real session token.
    await this.authService.changePassword(loginIdOf(user), dto.currentPassword, dto.newPassword, user.jti!, req.ip);
    return { success: true };
  }

  // First real backend implementation of logout — stateless JWTs had
  // nothing to invalidate before sessions existed (see frontend
  // authService.ts's previous no-op comment, now updated to call this).
  // RequireSessionAuthGuard here isn't about blast-radius (logout can't hurt
  // anything) — an API token has no session/jti to log out of in the first
  // place, so this is simply the correct guard for "this concept doesn't
  // apply to you."
  @UseGuards(JwtAuthGuard, RequireSessionAuthGuard)
  @Post('logout')
  async logout(@CurrentUser() user: JwtPayload) {
    await this.authService.logout(loginIdOf(user), user.jti!);
    return { success: true };
  }
}
