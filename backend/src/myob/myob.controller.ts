import { Body, Controller, Delete, Get, Logger, Post, Query, Redirect, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { SaveCompanyFileCredentialsDto } from './dto/save-company-file-credentials.dto';
import { MyobService } from './myob.service';

// Same shape as xero.controller.ts, plus one route no other provider here
// needs: company-file-credentials, for the second credential pair MYOB
// requires beyond OAuth (see myob.service.ts).
@Controller('myob')
export class MyobController {
  private readonly logger = new Logger(MyobController.name);

  constructor(
    private myob: MyobService,
    private config: ConfigService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get('app-status')
  async getAppStatus() {
    return { configured: await this.myob.isAppConfigured() };
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Get('connect-url')
  async getConnectUrl(@CurrentUser() user: JwtPayload) {
    return { url: await this.myob.buildAuthorizeUrl(user.organizationId) };
  }

  // MYOB returns businessId (the company file id) directly alongside code
  // on this redirect — confirmed from MYOB's own docs, not a guess.
  @Get('callback')
  @Redirect()
  async callback(
    @Query('code') code?: string,
    @Query('businessId') businessId?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    const frontendUrl = this.config.get<string>('corsOrigin');
    if (error || !code || !state || !businessId) {
      this.logger.warn(`MYOB callback missing params (error=${error})`);
      return { url: `${frontendUrl}/settings/integrations?myob=error`, statusCode: 302 };
    }
    try {
      await this.myob.handleCallback(code, businessId, state);
      return { url: `${frontendUrl}/settings/integrations?myob=connected`, statusCode: 302 };
    } catch (err) {
      this.logger.error(`MYOB callback failed: ${(err as Error).message}`);
      return { url: `${frontendUrl}/settings/integrations?myob=error`, statusCode: 302 };
    }
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Get('status')
  getStatus(@CurrentUser() user: JwtPayload) {
    return this.myob.getStatus(user.organizationId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Post('company-file-credentials')
  saveCompanyFileCredentials(@CurrentUser() user: JwtPayload, @Body() dto: SaveCompanyFileCredentialsDto) {
    return this.myob.saveCompanyFileCredentials(user.organizationId, dto.username, dto.password);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin')
  @Delete('disconnect')
  disconnect(@CurrentUser() user: JwtPayload) {
    return this.myob.disconnect(user.organizationId);
  }
}
