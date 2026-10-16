import { Body, Controller, Get, Logger, Post, Query, Redirect, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { SaveZohoAppCredentialsDto } from './dto/save-app-credentials.dto';
import { ZohoService } from './zoho.service';

// Zoho CRM's real OAuth flow — mirrors outlook.controller.ts's shape
// (connect-url -> signed JWT state -> provider consent -> callback -> token
// exchange), with one real difference: a Zoho connection here is one per
// ORGANIZATION, not per user (see zoho.service.ts), so connect-url requires
// the same owner/admin role CrmIntegrationsController already requires for
// every other CRM connect action, and the state carries organizationId only.
@Controller('zoho')
export class ZohoController {
  private readonly logger = new Logger(ZohoController.name);

  constructor(
    private zoho: ZohoService,
    private config: ConfigService,
  ) {}

  // The organization's own Zoho API Console app (Client ID/Secret/data
  // center) — collected once via Settings -> Integrations' "Connect Zoho
  // CRM" credential modal, before the first authorize redirect. Same
  // owner/admin gate as connect-url: this never returns the secret back
  // (see ZohoService.getAppCredentialsStatus), only whether one is on file.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Post('app-credentials')
  saveAppCredentials(@CurrentUser() user: JwtPayload, @Body() dto: SaveZohoAppCredentialsDto) {
    return this.zoho.saveAppCredentials(user.organizationId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Get('app-credentials')
  getAppCredentialsStatus(@CurrentUser() user: JwtPayload) {
    return this.zoho.getAppCredentialsStatus(user.organizationId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Get('connect-url')
  async getConnectUrl(@CurrentUser() user: JwtPayload) {
    return { url: await this.zoho.buildAuthorizeUrl(user.organizationId) };
  }

  // Called by Zoho, not a signed-in browser — the state param (a signed JWT,
  // verified inside handleCallback) is what actually authenticates this
  // request, same as Outlook/Gmail's callbacks. `accounts-server` is Zoho's
  // own documented multi-data-center response field (see zoho.service.ts);
  // `location` is informational only and not used.
  @Get('callback')
  @Redirect()
  async callback(
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
    @Query('accounts-server') accountsServer?: string,
  ) {
    const frontendUrl = this.config.get<string>('corsOrigin');
    if (error || !code || !state) {
      this.logger.warn(`Zoho callback missing params (error=${error})`);
      return { url: `${frontendUrl}/settings/integrations?crm=zoho_error`, statusCode: 302 };
    }
    try {
      await this.zoho.handleCallback(code, state, accountsServer);
      return { url: `${frontendUrl}/settings/integrations?crm=zoho_connected`, statusCode: 302 };
    } catch (err) {
      this.logger.error(`Zoho callback failed: ${(err as Error).message}`);
      return { url: `${frontendUrl}/settings/integrations?crm=zoho_error`, statusCode: 302 };
    }
  }
}
