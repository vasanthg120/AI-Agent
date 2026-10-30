import { Body, Controller, Delete, Get, Logger, Post, Query, Redirect, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { SaveZohoAppCredentialsDto } from '../zoho/dto/save-app-credentials.dto';
import { SelectOrganizationDto } from './dto/select-organization.dto';
import { ZohoBooksService } from './zohobooks.service';

// Mirrors zoho.controller.ts's shape exactly (own app-credentials routes,
// connect-url, callback) plus one route Zoho CRM doesn't need: selecting
// which Zoho Books "organization" to use when the authorization covered
// more than one (see zohobooks.service.ts). status/disconnect live here
// too, same as xero.controller.ts — Books isn't a CRM, so none of this goes
// through crm-integrations.
@Controller('zohobooks')
export class ZohoBooksController {
  private readonly logger = new Logger(ZohoBooksController.name);

  constructor(
    private zohoBooks: ZohoBooksService,
    private config: ConfigService,
  ) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Post('app-credentials')
  saveAppCredentials(@CurrentUser() user: JwtPayload, @Body() dto: SaveZohoAppCredentialsDto) {
    return this.zohoBooks.saveAppCredentials(user.organizationId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Get('app-credentials')
  getAppCredentialsStatus(@CurrentUser() user: JwtPayload) {
    return this.zohoBooks.getAppCredentialsStatus(user.organizationId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Get('connect-url')
  async getConnectUrl(@CurrentUser() user: JwtPayload) {
    return { url: await this.zohoBooks.buildAuthorizeUrl(user.organizationId) };
  }

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
      this.logger.warn(`Zoho Books callback missing params (error=${error})`);
      return { url: `${frontendUrl}/settings/integrations?zohobooks=error`, statusCode: 302 };
    }
    try {
      const { needsSelection } = await this.zohoBooks.handleCallback(code, state, accountsServer);
      return { url: `${frontendUrl}/settings/integrations?zohobooks=${needsSelection ? 'select_org' : 'connected'}`, statusCode: 302 };
    } catch (err) {
      this.logger.error(`Zoho Books callback failed: ${(err as Error).message}`);
      return { url: `${frontendUrl}/settings/integrations?zohobooks=error`, statusCode: 302 };
    }
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Get('status')
  getStatus(@CurrentUser() user: JwtPayload) {
    return this.zohoBooks.getStatus(user.organizationId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Post('select-organization')
  selectOrganization(@CurrentUser() user: JwtPayload, @Body() dto: SelectOrganizationDto) {
    return this.zohoBooks.selectOrganization(user.organizationId, dto.organizationId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Delete('disconnect')
  disconnect(@CurrentUser() user: JwtPayload) {
    return this.zohoBooks.disconnect(user.organizationId);
  }
}
