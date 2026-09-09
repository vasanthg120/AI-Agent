import { Body, Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { ConnectIntegrationDto } from './dto/connect-integration.dto';
import { IntegrationsService } from './integrations.service';

// Anthropic's credential has always been read platform-wide at the point it
// actually matters: python-agent's anthropic_client.py._resolve_api_key()
// calls integration_store.get_api_key("anthropic") with NO organizationId
// filter, so whichever integration_credentials row exists for provider
// "anthropic" is the one every organization's chat/Outlook-analysis calls
// actually use. This controller just gives that already-global setting a
// platform-admin-gated home instead of a customer-org one — reusing
// IntegrationsService's connect/status/disconnect methods completely as-is
// (same encryption, same masking, same validation), only passing a fixed
// scope string instead of a customer's real organizationId. No schema
// change, no new storage shape, no change to the existing customer-facing
// IntegrationsController routes.
//
// Deliberately hardcodes provider 'anthropic' rather than exposing a
// :provider param — this is not a general "admin can manage any
// organization's integration" surface, only the one provider that belongs
// at the platform level.
const PLATFORM_INTEGRATION_SCOPE = 'platform';

@UseGuards(AdminJwtAuthGuard)
@Controller('integrations/admin')
export class AdminIntegrationsController {
  constructor(private integrationsService: IntegrationsService) {}

  @Post('anthropic/connect')
  connect(@Body() dto: ConnectIntegrationDto) {
    return this.integrationsService.connectFromDto(PLATFORM_INTEGRATION_SCOPE, 'anthropic', dto);
  }

  @Get('anthropic/status')
  status() {
    return this.integrationsService.status(PLATFORM_INTEGRATION_SCOPE, 'anthropic');
  }

  @Delete('anthropic')
  disconnect() {
    return this.integrationsService.disconnect(PLATFORM_INTEGRATION_SCOPE, 'anthropic');
  }
}
