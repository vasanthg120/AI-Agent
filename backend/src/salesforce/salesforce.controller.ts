import { Controller, Get, Logger, Query, Redirect, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { SalesforceService } from './salesforce.service';

// Salesforce's real OAuth flow — mirrors outlook.controller.ts's shape
// (connect-url -> signed JWT state -> provider consent -> callback -> token
// exchange), with one real difference: a Salesforce connection here is one
// per ORGANIZATION, not per user (see salesforce.service.ts), so connect-url
// requires the same owner/admin role CrmIntegrationsController already
// requires for every other CRM connect action, and the state carries
// organizationId only.
@Controller('salesforce')
export class SalesforceController {
  private readonly logger = new Logger(SalesforceController.name);
  
  constructor(
    private salesforce: SalesforceService,
    private config: ConfigService,
  ) {}
  
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Get('connect-url')
  getConnectUrl(@CurrentUser() user: JwtPayload) {
    return { url: this.salesforce.buildAuthorizeUrl(user.organizationId) };
  }

  // Called by Salesforce, not a signed-in browser — the state param (a
  // signed JWT, verified inside handleCallback) is what actually
  // authenticates this request, same as Outlook/Gmail's callbacks.
  @Get('callback')
  @Redirect()
  async callback(@Query('code') code?: string, @Query('state') state?: string, @Query('error') error?: string) {
    const frontendUrl = this.config.get<string>('corsOrigin');
    if (error || !code || !state) {
      this.logger.warn(`Salesforce callback missing params (error=${error})`);
      return { url: `${frontendUrl}/settings/integrations?crm=salesforce_error`, statusCode: 302 };
    }
    try {
      await this.salesforce.handleCallback(code, state);
      return { url: `${frontendUrl}/settings/integrations?crm=salesforce_connected`, statusCode: 302 };
    } catch (err) {
      this.logger.error(`Salesforce callback failed: ${(err as Error).message}`);
      return { url: `${frontendUrl}/settings/integrations?crm=salesforce_error`, statusCode: 302 };
    }
  }
}
