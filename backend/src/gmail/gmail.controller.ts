import { Controller, Delete, Get, Logger, Param, Post, Query, Redirect, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { GmailService } from './gmail.service';

// Same route shape as outlook.controller.ts — connect-url/callback/status/
// accounts/activate/disconnect.
@Controller('gmail')
export class GmailController {
  private readonly logger = new Logger(GmailController.name);

  constructor(
    private gmailService: GmailService,
    private jwtService: JwtService,
    private config: ConfigService,
  ) {}

  // Any authenticated user — a read-only "is Gmail available at all" check,
  // not the admin-only credential status (see admin-integrations.controller.ts's
  // GET gmail/app-credentials for that). Drives IntegrationsPage.tsx showing
  // either the normal Connect button or "ask your administrator" messaging.
  @UseGuards(JwtAuthGuard)
  @Get('app-status')
  async getAppStatus() {
    return { configured: await this.gmailService.isAppConfigured() };
  }

  @UseGuards(JwtAuthGuard)
  @Get('connect-url')
  async getConnectUrl(@CurrentUser() user: JwtPayload) {
    // Short-lived JWT as OAuth `state` — carries the user id through the
    // Google redirect round-trip without needing a server session.
    const state = this.jwtService.sign({ sub: user.sub }, { expiresIn: '10m' });
    return { url: await this.gmailService.buildAuthorizeUrl(state) };
  }

  @Get('callback')
  @Redirect()
  async callback(
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    const frontendUrl = this.config.get<string>('corsOrigin');
    if (error || !code || !state) {
      this.logger.warn(`Gmail callback missing params (error=${error})`);
      return { url: `${frontendUrl}/chat?gmail=error`, statusCode: 302 };
    }
    try {
      const payload = this.jwtService.verify<{ sub: string }>(state);
      await this.gmailService.handleCallback(code, payload.sub);
      return { url: `${frontendUrl}/chat?gmail=connected`, statusCode: 302 };
    } catch (err) {
      const detail = (err as { response?: { data?: unknown } }).response?.data ?? (err as Error).message;
      this.logger.error(`Gmail callback failed: ${JSON.stringify(detail)}`);
      return { url: `${frontendUrl}/chat?gmail=error`, statusCode: 302 };
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get('status')
  getStatus(@CurrentUser() user: JwtPayload) {
    return this.gmailService.getStatus(user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Get('accounts')
  listAccounts(@CurrentUser() user: JwtPayload) {
    return this.gmailService.listAccounts(user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Post('accounts/:email/activate')
  setActive(@CurrentUser() user: JwtPayload, @Param('email') email: string) {
    return this.gmailService.setActive(user.sub, decodeURIComponent(email));
  }

  @UseGuards(JwtAuthGuard)
  @Delete('accounts/:email')
  disconnectAccount(@CurrentUser() user: JwtPayload, @Param('email') email: string) {
    return this.gmailService.disconnect(user.sub, decodeURIComponent(email));
  }
}
