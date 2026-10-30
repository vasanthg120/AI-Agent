import { Body, Controller, Delete, Get, Logger, Post, Query, Redirect, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { SelectTenantDto } from './dto/select-tenant.dto';
import { XeroService } from './xero.service';

// Same route shape as zoho.controller.ts (connect-url -> signed JWT state ->
// provider consent -> callback -> token exchange), plus status/disconnect
// routes directly here (not delegated to crm-integrations — Xero is an
// Accounting connection, not a CRM) and a select-tenant step for the
// multi-organisation case (see xero.service.ts).
@Controller('xero')
export class XeroController {
  private readonly logger = new Logger(XeroController.name);

  constructor(
    private xero: XeroService,
    private config: ConfigService,
  ) {}

  // Any authenticated user — read-only "is Xero available at all" check,
  // same role Gmail's GET /gmail/app-status plays.
  @UseGuards(JwtAuthGuard)
  @Get('app-status')
  async getAppStatus() {
    return { configured: await this.xero.isAppConfigured() };
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Get('connect-url')
  async getConnectUrl(@CurrentUser() user: JwtPayload) {
    return { url: await this.xero.buildAuthorizeUrl(user.organizationId) };
  }

  // Called by Xero, not a signed-in browser — the state param (a signed
  // JWT, verified inside handleCallback) is what actually authenticates
  // this request, same as Zoho/Outlook/Gmail's callbacks.
  @Get('callback')
  @Redirect()
  async callback(@Query('code') code?: string, @Query('state') state?: string, @Query('error') error?: string) {
    const frontendUrl = this.config.get<string>('corsOrigin');
    if (error || !code || !state) {
      this.logger.warn(`Xero callback missing params (error=${error})`);
      return { url: `${frontendUrl}/settings/integrations?xero=error`, statusCode: 302 };
    }
    try {
      const { needsSelection } = await this.xero.handleCallback(code, state);
      return { url: `${frontendUrl}/settings/integrations?xero=${needsSelection ? 'select_tenant' : 'connected'}`, statusCode: 302 };
    } catch (err) {
      this.logger.error(`Xero callback failed: ${(err as Error).message}`);
      return { url: `${frontendUrl}/settings/integrations?xero=error`, statusCode: 302 };
    }
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Get('status')
  getStatus(@CurrentUser() user: JwtPayload) {
    return this.xero.getStatus(user.organizationId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Post('select-tenant')
  selectTenant(@CurrentUser() user: JwtPayload, @Body() dto: SelectTenantDto) {
    return this.xero.selectTenant(user.organizationId, dto.tenantId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Delete('disconnect')
  disconnect(@CurrentUser() user: JwtPayload) {
    return this.xero.disconnect(user.organizationId);
  }
}
