import { Body, Controller, Delete, Get, Logger, Param, Post, Put, Query, Redirect, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { isAdminConsentRequiredError, OutlookService } from './outlook.service';

@Controller('outlook')
export class OutlookController {
  private readonly logger = new Logger(OutlookController.name);

  constructor(
    private outlookService: OutlookService,
    private jwtService: JwtService,
    private config: ConfigService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get('emails')
  getEmails() {
    return this.outlookService.getEmails();
  }

  @UseGuards(JwtAuthGuard)
  @Get('calendar')
  getCalendarEvents() {
    return this.outlookService.getCalendarEvents();
  }

  @UseGuards(JwtAuthGuard)
  @Get('contacts')
  getContacts() {
    return this.outlookService.getContacts();
  }

  @UseGuards(JwtAuthGuard)
  @Get('connect-url')
  async getConnectUrl(@CurrentUser() user: JwtPayload) {
    // Short-lived JWT as OAuth `state` — carries the user id (and org, so
    // the callback below can attribute the connection to the right
    // organization for the org-wide accounts view) through the Microsoft
    // redirect round-trip without needing a server session.
    const state = this.jwtService.sign({ sub: user.sub, organizationId: user.organizationId }, { expiresIn: '10m' });
    return { url: await this.outlookService.buildAuthorizeUrl(state) };
  }

  @Get('callback')
  @Redirect()
  async callback(
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
    @Query('error_description') errorDescription?: string,
  ) {
    const frontendUrl = this.config.get<string>('corsOrigin');
    if (error || !code || !state) {
      this.logger.warn(`Outlook callback missing params (error=${error}, description=${errorDescription})`);
      const reason = isAdminConsentRequiredError(errorDescription) ? 'admin_consent_required' : 'error';
      return { url: `${frontendUrl}/integrations?outlook=${reason}`, statusCode: 302 };
    }
    try {
      const payload = this.jwtService.verify<{ sub: string; organizationId?: string }>(state);
      await this.outlookService.handleCallback(code, payload.sub, payload.organizationId);
      return { url: `${frontendUrl}/integrations?outlook=connected`, statusCode: 302 };
    } catch (err) {
      const detail = (err as { response?: { data?: unknown } }).response?.data ?? (err as Error).message;
      this.logger.error(`Outlook callback failed: ${JSON.stringify(detail)}`);
      return { url: `${frontendUrl}/integrations?outlook=error`, statusCode: 302 };
    }
  }

  // Tenant-wide admin consent — a separate, distinct Microsoft flow from
  // connect-url/callback above (no `code`, no per-mailbox connection
  // created). A tenant admin visits the returned URL once; every employee
  // in their organization can then use connect-url normally without
  // Microsoft's "Need admin approval" wall. See outlook.service.ts's
  // buildAdminConsentUrl for why nothing else in this app has to branch on
  // whether this has happened — Microsoft enforces it automatically.
  @UseGuards(JwtAuthGuard)
  @Get('admin-consent-url')
  async getAdminConsentUrl(@CurrentUser() user: JwtPayload) {
    const state = this.jwtService.sign(
      { sub: user.sub, organizationId: user.organizationId, email: user.email },
      { expiresIn: '10m' },
    );
    return { url: await this.outlookService.buildAdminConsentUrl(state) };
  }

  @Get('admin-consent-callback')
  @Redirect()
  async adminConsentCallback(
    @Query('tenant') tenant?: string,
    @Query('admin_consent') adminConsent?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
    @Query('error_description') errorDescription?: string,
  ) {
    const frontendUrl = this.config.get<string>('corsOrigin');
    if (error || adminConsent !== 'True' || !tenant || !state) {
      this.logger.warn(`Admin consent declined or failed (error=${error}, description=${errorDescription})`);
      return { url: `${frontendUrl}/integrations?outlook=admin_consent_declined`, statusCode: 302 };
    }
    try {
      const payload = this.jwtService.verify<{ sub: string; organizationId: string; email: string }>(state);
      await this.outlookService.recordTenantAuthorization(tenant, payload.organizationId, payload.sub, payload.email);
      return { url: `${frontendUrl}/integrations?outlook=admin_consent_granted`, statusCode: 302 };
    } catch (err) {
      this.logger.error(`Admin consent callback failed: ${(err as Error).message}`);
      return { url: `${frontendUrl}/integrations?outlook=error`, statusCode: 302 };
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get('tenant-authorization-status')
  getTenantAuthorizationStatus(@CurrentUser() user: JwtPayload) {
    return this.outlookService.getTenantAuthorizationStatus(user.organizationId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('status')
  getStatus(@CurrentUser() user: JwtPayload) {
    return this.outlookService.getStatus(user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Get('accounts')
  listAccounts(@CurrentUser() user: JwtPayload) {
    return this.outlookService.listAccounts(user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Post('accounts/:email/activate')
  setActive(@CurrentUser() user: JwtPayload, @Param('email') email: string) {
    return this.outlookService.setActive(user.sub, decodeURIComponent(email));
  }

  // Whose work this mailbox's email counts as on the team dashboards — for a
  // shared mailbox connected by one person and answered by another.
  @UseGuards(JwtAuthGuard)
  @Put('accounts/:email/handler')
  setHandler(@CurrentUser() user: JwtPayload, @Param('email') email: string, @Body() body: { userId?: string | null }) {
    return this.outlookService.setHandler(user.sub, user.organizationId, decodeURIComponent(email), body?.userId || null);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('accounts/:email')
  disconnectAccount(@CurrentUser() user: JwtPayload, @Param('email') email: string) {
    return this.outlookService.disconnect(user.sub, decodeURIComponent(email));
  }

  // Org-wide view (every user's connected mailboxes, not just the caller's
  // own) — the "sales@/support@/hr@ connected by different team members"
  // dashboard. Any authenticated org member can view; connect/disconnect
  // stays scoped to the account's own owner via the endpoints above.
  @UseGuards(JwtAuthGuard)
  @Get('org-accounts')
  listOrgAccounts(@CurrentUser() user: JwtPayload) {
    return this.outlookService.listOrgAccounts(user.organizationId);
  }
}
