import { BadRequestException, Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { ConnectIntegrationDto } from './dto/connect-integration.dto';
import { IntegrationsService } from './integrations.service';

// Anthropic, Sarvam, and Groq are all platform-wide AI provider credentials —
// python-agent's anthropic_client.py._resolve_api_key(),
// sarvam_client.py._require_api_key(), and groq_client.py._resolve_api_key()
// all look up EXACTLY {provider, organizationId: "platform"} (an explicit
// filter, not an unscoped "first match wins" query), and never fall back to
// any organization's own credential or to a static .env value. This
// controller gives that platform-scoped setting a platform-admin-gated home —
// reusing IntegrationsService's connect/status/disconnect methods completely
// as-is (same encryption, same masking, same validation), only ever passing
// the fixed PLATFORM_INTEGRATION_SCOPE constant, never anything client-supplied.
// No schema change, no new storage shape, no change to the existing
// customer-facing IntegrationsController routes (old per-organization
// Anthropic credentials some customers connected before this existed are
// left untouched in Mongo — just no longer reachable by the platform AI
// runtime, which now looks up "platform" explicitly).
//
// Groq is optional in a way Anthropic/Sarvam aren't: it's only ever used as
// orchestrator.py's fast "general knowledge" bypass, which already falls
// through to the unchanged Anthropic path on ANY failure (missing key
// included) — so leaving Groq disconnected here is a safe, expected state,
// not a broken one.
//
// Deliberately hardcodes provider to 'anthropic'/'sarvam'/'groq' rather than
// exposing a :provider param — this is not a general "admin can manage any
// organization's integration" surface, only the providers that belong at the
// platform level.
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

  @Post('groq/connect')
  connectGroq(@Body() dto: ConnectIntegrationDto) {
    return this.integrationsService.connectFromDto(PLATFORM_INTEGRATION_SCOPE, 'groq', dto);
  }

  @Get('groq/status')
  groqStatus() {
    return this.integrationsService.status(PLATFORM_INTEGRATION_SCOPE, 'groq');
  }

  @Delete('groq')
  disconnectGroq() {
    return this.integrationsService.disconnect(PLATFORM_INTEGRATION_SCOPE, 'groq');
  }

  // "Configured" (the three GET .../status routes above) vs "actually
  // reachable right now" — see IntegrationsService.verifyPlatformProvider's
  // own comment. One shared route rather than three, since the check is
  // identical in shape for all three providers; :provider is validated
  // against the fixed allow-list, never passed through unchecked.
  @Post(':provider/verify')
  verifyProvider(@Param('provider') provider: string) {
    if (provider !== 'anthropic' && provider !== 'sarvam' && provider !== 'groq') {
      throw new BadRequestException(`Unknown provider '${provider}'`);
    }
    return this.integrationsService.verifyPlatformProvider(provider);
  }
}
