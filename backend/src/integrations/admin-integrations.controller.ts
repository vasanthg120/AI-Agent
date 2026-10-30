import { BadRequestException, Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { ConnectIntegrationDto } from './dto/connect-integration.dto';
import { SaveOAuthAppCredentialsDto } from './dto/save-oauth-app-credentials.dto';
import { IntegrationsService, PLATFORM_PROVIDERS, PlatformProvider } from './integrations.service';

// Anthropic, Sarvam, ElevenLabs, and Groq are all platform-wide AI provider
// credentials — python-agent's anthropic_client.py._resolve_api_key(),
// sarvam_client.py._require_api_key(), tts/elevenlabs.py._require_api_key(),
// and groq_client.py._resolve_api_key()
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
// Deliberately hardcodes provider to 'anthropic'/'sarvam'/'elevenlabs'/'groq'
// rather than exposing a :provider param — this is not a general "admin can manage any
// organization's integration" surface, only the providers that belong at the
// platform level.
const PLATFORM_INTEGRATION_SCOPE = 'platform';

function isPlatformProvider(provider: string): provider is PlatformProvider {
  return (PLATFORM_PROVIDERS as readonly string[]).includes(provider);
}

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

  // ElevenLabs supplies the Australian/American/British English voices Sarvam
  // can't speak (see python-agent/app/integrations/tts/elevenlabs.py). Like
  // Groq it is optional — without it those voices show as unavailable in Voice
  // & Accent and the Indian voices keep working.
  @Post('elevenlabs/connect')
  connectElevenLabs(@Body() dto: ConnectIntegrationDto) {
    return this.integrationsService.connectFromDto(PLATFORM_INTEGRATION_SCOPE, 'elevenlabs', dto);
  }

  @Get('elevenlabs/status')
  elevenLabsStatus() {
    return this.integrationsService.status(PLATFORM_INTEGRATION_SCOPE, 'elevenlabs');
  }

  @Delete('elevenlabs')
  disconnectElevenLabs() {
    return this.integrationsService.disconnect(PLATFORM_INTEGRATION_SCOPE, 'elevenlabs');
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

  // Gmail's own Google OAuth app (Client ID/Secret) — a different kind of
  // platform credential from the AI providers above (there's no "ping to
  // verify" for an OAuth client, and reads/writes go through
  // saveOAuthAppCredentials/getOAuthAppCredentialsStatus, not
  // connectFromDto/status, which assume a single apiKey/authType shape).
  // Same PLATFORM_INTEGRATION_SCOPE, same AdminJwtAuthGuard — an ordinary
  // customer user can never reach this controller at all (see
  // gmail.controller.ts's own GET /gmail/app-status for the read-only,
  // customer-facing "is it configured" check this backs). One platform-wide
  // app for every organization's Gmail mailboxes, same as Outlook/Gmail's
  // existing per-user-delegated-auth-against-one-shared-app design — Google
  // has no per-tenant data-center fragmentation to justify Zoho's per-
  // organization app pattern (see zoho.service.ts), so this deliberately
  // does NOT duplicate that shape.
  @Post('gmail/app-credentials')
  saveGmailAppCredentials(@Body() dto: SaveOAuthAppCredentialsDto) {
    return this.integrationsService.saveOAuthAppCredentials(PLATFORM_INTEGRATION_SCOPE, 'gmail', {
      clientId: dto.clientId.trim(),
      clientSecret: dto.clientSecret.trim(),
    });
  }

  @Get('gmail/app-credentials')
  getGmailAppCredentialsStatus() {
    return this.integrationsService.getOAuthAppCredentialsStatus(PLATFORM_INTEGRATION_SCOPE, 'gmail');
  }

  // Xero's own developer-portal app (Client ID/Secret) — same shape as
  // Gmail's pair above, for the same reason: Xero has one global API with no
  // per-tenant data-center fragmentation (unlike Zoho), so one platform-wide
  // app covers every organization, each of which authorizes its own Xero
  // tenant(s) against it (see xero.service.ts).
  @Post('xero/app-credentials')
  saveXeroAppCredentials(@Body() dto: SaveOAuthAppCredentialsDto) {
    return this.integrationsService.saveOAuthAppCredentials(PLATFORM_INTEGRATION_SCOPE, 'xero', {
      clientId: dto.clientId.trim(),
      clientSecret: dto.clientSecret.trim(),
    });
  }

  @Get('xero/app-credentials')
  getXeroAppCredentialsStatus() {
    return this.integrationsService.getOAuthAppCredentialsStatus(PLATFORM_INTEGRATION_SCOPE, 'xero');
  }

  // MYOB's own developer-portal app — same platform-wide shape as Gmail/
  // Xero above (see myob.service.ts).
  @Post('myob/app-credentials')
  saveMyobAppCredentials(@Body() dto: SaveOAuthAppCredentialsDto) {
    return this.integrationsService.saveOAuthAppCredentials(PLATFORM_INTEGRATION_SCOPE, 'myob', {
      clientId: dto.clientId.trim(),
      clientSecret: dto.clientSecret.trim(),
    });
  }

  @Get('myob/app-credentials')
  getMyobAppCredentialsStatus() {
    return this.integrationsService.getOAuthAppCredentialsStatus(PLATFORM_INTEGRATION_SCOPE, 'myob');
  }

  // Outlook's Azure App Registration (Client ID/Secret) — same platform-wide
  // shape as Gmail/Xero/MYOB above (see outlook.service.ts's
  // resolveAppCredentials). Removes the previous hard MS_GRAPH_CLIENT_SECRET
  // .env dependency: that env var is now only a backward-compatible fallback
  // for a deployment that set it before this existed, never required.
  @Post('outlook/app-credentials')
  saveOutlookAppCredentials(@Body() dto: SaveOAuthAppCredentialsDto) {
    return this.integrationsService.saveOAuthAppCredentials(PLATFORM_INTEGRATION_SCOPE, 'outlook', {
      clientId: dto.clientId.trim(),
      clientSecret: dto.clientSecret.trim(),
    });
  }

  @Get('outlook/app-credentials')
  getOutlookAppCredentialsStatus() {
    return this.integrationsService.getOAuthAppCredentialsStatus(PLATFORM_INTEGRATION_SCOPE, 'outlook');
  }

  // "Configured" (the GET .../status routes above) vs "actually reachable
  // right now" — see IntegrationsService.verifyPlatformProvider's own comment.
  // One shared route rather than one per provider, since the check is
  // identical in shape for all of them; :provider is validated against the
  // fixed allow-list, never passed through unchecked.
  @Post(':provider/verify')
  verifyProvider(@Param('provider') provider: string) {
    if (!isPlatformProvider(provider)) {
      throw new BadRequestException(`Unknown provider '${provider}'`);
    }
    return this.integrationsService.verifyPlatformProvider(provider);
  }
}
