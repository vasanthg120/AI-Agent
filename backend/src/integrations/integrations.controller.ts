import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ConnectIntegrationDto } from './dto/connect-integration.dto';
import { TestConnectionDto } from './dto/test-connection.dto';
import { IntegrationsService } from './integrations.service';

@UseGuards(JwtAuthGuard)
@Controller('integrations')
export class IntegrationsController {
  constructor(private integrationsService: IntegrationsService) {}

  // Every custom integration connected for this org (excludes anthropic/crm,
  // which keep their own fixed cards) — the generic "connect any CRM/SaaS"
  // list.
  @Get()
  listCustom(@CurrentUser() user: JwtPayload) {
    return this.integrationsService.listCustom(user.organizationId);
  }

  // "Smart provider detection" (see provider-rules.ts) — the Add
  // Integration wizard calls this as the user types a provider name, to
  // show only the auth methods that provider actually supports (or point
  // them at an existing dedicated flow like Outlook/Gmail instead).
  @Get('provider-rules/:provider')
  getProviderRule(@Param('provider') provider: string) {
    return this.integrationsService.getProviderRule(provider);
  }

  // Manual "Sync Now" — pulls fresh CRM data immediately instead of waiting
  // for python-agent's background poll (crm_mongo_sync_interval_minutes) or
  // having to disconnect/reconnect to trigger IntegrationsService's
  // post-connect sync. Same admin gate as connect/disconnect below: this
  // still causes real outbound calls to the connected CRM's API.
  @Post('crm/sync')
  @UseGuards(RolesGuard)
  @Roles('admin')
  syncCrmNow(@CurrentUser() user: JwtPayload) {
    return this.integrationsService.syncCrmNow(user.organizationId);
  }

  // Writes a per-org credential (see integration-credential.schema.ts — one
  // doc per (org, provider), not per-user) — previously connectable/
  // disconnectable by any authenticated user regardless of role. Routes to
  // the legacy apiKey-only path or the newer multi-auth-type path based on
  // whether the body sets `authType` (see IntegrationsService.connectFromDto)
  // — same endpoint either way, so existing callers (anthropic/crm) are
  // unaffected.
  @Post(':provider/connect')
  @UseGuards(RolesGuard)
  @Roles('admin')
  connect(@CurrentUser() user: JwtPayload, @Param('provider') provider: string, @Body() dto: ConnectIntegrationDto) {
    return this.integrationsService.connectFromDto(user.organizationId, provider, dto);
  }

  // Pings the provider with either the just-entered (pre-save) credentials
  // or, if the body is empty, the already-saved ones — "Test Connection"
  // before committing, or "re-check" afterward, same endpoint either way.
  @Post(':provider/test')
  @UseGuards(RolesGuard)
  @Roles('admin')
  testConnection(@CurrentUser() user: JwtPayload, @Param('provider') provider: string, @Body() dto: TestConnectionDto) {
    return this.integrationsService.testConnection(user.organizationId, provider, dto);
  }

  @Get(':provider/status')
  status(@CurrentUser() user: JwtPayload, @Param('provider') provider: string) {
    return this.integrationsService.status(user.organizationId, provider);
  }

  @Delete(':provider')
  @UseGuards(RolesGuard)
  @Roles('admin')
  disconnect(@CurrentUser() user: JwtPayload, @Param('provider') provider: string) {
    return this.integrationsService.disconnect(user.organizationId, provider);
  }
}
