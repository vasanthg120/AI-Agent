import { Body, Controller, Delete, Get, Logger, Post, Query, Redirect, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { SaveZohoAppCredentialsDto } from '../zoho/dto/save-app-credentials.dto';
import { SelectOrganizationDto } from './dto/select-organization.dto';
import { ZohoPayrollService } from './zohopayroll.service';

// Mirrors zohobooks.controller.ts's shape exactly — own app-credentials
// routes (per-org "bring your own app"), connect-url, callback,
// select-organization, status/disconnect. Not a CRM, so none of this goes
// through crm-integrations.
@Controller('zohopayroll')
export class ZohoPayrollController {
  private readonly logger = new Logger(ZohoPayrollController.name);

  constructor(
    private zohoPayroll: ZohoPayrollService,
    private config: ConfigService,
  ) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Post('app-credentials')
  saveAppCredentials(@CurrentUser() user: JwtPayload, @Body() dto: SaveZohoAppCredentialsDto) {
    return this.zohoPayroll.saveAppCredentials(user.organizationId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Get('app-credentials')
  getAppCredentialsStatus(@CurrentUser() user: JwtPayload) {
    return this.zohoPayroll.getAppCredentialsStatus(user.organizationId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Get('connect-url')
  async getConnectUrl(@CurrentUser() user: JwtPayload) {
    return { url: await this.zohoPayroll.buildAuthorizeUrl(user.organizationId) };
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
      this.logger.warn(`Zoho Payroll callback missing params (error=${error})`);
      return { url: `${frontendUrl}/settings/integrations?zohopayroll=error`, statusCode: 302 };
    }
    try {
      const { needsSelection } = await this.zohoPayroll.handleCallback(code, state, accountsServer);
      return { url: `${frontendUrl}/settings/integrations?zohopayroll=${needsSelection ? 'select_org' : 'connected'}`, statusCode: 302 };
    } catch (err) {
      this.logger.error(`Zoho Payroll callback failed: ${(err as Error).message}`);
      return { url: `${frontendUrl}/settings/integrations?zohopayroll=error`, statusCode: 302 };
    }
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Get('status')
  getStatus(@CurrentUser() user: JwtPayload) {
    return this.zohoPayroll.getStatus(user.organizationId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Post('select-organization')
  selectOrganization(@CurrentUser() user: JwtPayload, @Body() dto: SelectOrganizationDto) {
    return this.zohoPayroll.selectOrganization(user.organizationId, dto.organizationId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Delete('disconnect')
  disconnect(@CurrentUser() user: JwtPayload) {
    return this.zohoPayroll.disconnect(user.organizationId);
  }
}
