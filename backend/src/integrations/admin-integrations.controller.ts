import { Body, Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { ConnectIntegrationDto } from './dto/connect-integration.dto';
import { IntegrationsService } from './integrations.service';

// Anthropic and Sarvam are both platform-wide AI provider credentials —
// python-agent's anthropic_client.py._resolve_api_key() and
// sarvam_client.py._require_api_key() both look up EXACTLY
// {provider, organizationId: "platform"} (an explicit filter, not an
// unscoped "first match wins" query), and never fall back to any
// organization's own credential or to a static .env value. This controller
// gives that platform-scoped setting a platform-admin-gated home — reusing
// IntegrationsService's connect/status/disconnect methods completely as-is
// (same encryption, same masking, same validation), only ever passing the
// fixed PLATFORM_INTEGRATION_SCOPE constant, never anything client-supplied.
// No schema change, no new storage shape, no change to the existing
// customer-facing IntegrationsController routes (old per-organization
// Anthropic credentials some customers connected before this existed are
// left untouched in Mongo — just no longer reachable by the platform AI
// runtime, which now looks up "platform" explicitly).
//
// Deliberately hardcodes provider to 'anthropic'/'sarvam' rather than
// exposing a :provider param — this is not a general "admin can manage any
// organization's integration" surface, only the two providers that belong
// at the platform level.
const PLATFORM_INTEGRATION_SCOPE = 'platform';

@UseGuards(AdminJwtAuthGuard)
@Controller('integrations/admin')
export class AdminIntegrationsController {
  constructor(private integrationsService: IntegrationsService) {}

  @Post('anthropic/connect')
  connectAnthropic(@Body() dto: ConnectIntegrationDto) {
    return this.integrationsService.connectFromDto(PLATFORM_INTEGRATION_SCOPE, 'anthropic', dto);
  }

  @Get('anthropic/status')
  anthropicStatus() {
    return this.integrationsService.status(PLATFORM_INTEGRATION_SCOPE, 'anthropic');
  }

  @Delete('anthropic')
  disconnectAnthropic() {
    return this.integrationsService.disconnect(PLATFORM_INTEGRATION_SCOPE, 'anthropic');
  }

  @Post('sarvam/connect')
  connectSarvam(@Body() dto: ConnectIntegrationDto) {
    return this.integrationsService.connectFromDto(PLATFORM_INTEGRATION_SCOPE, 'sarvam', dto);
  }

  @Get('sarvam/status')
  sarvamStatus() {
    return this.integrationsService.status(PLATFORM_INTEGRATION_SCOPE, 'sarvam');
  }

  @Delete('sarvam')
  disconnectSarvam() {
    return this.integrationsService.disconnect(PLATFORM_INTEGRATION_SCOPE, 'sarvam');
  }
}
