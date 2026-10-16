import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { firstValueFrom } from 'rxjs';
import { CrmIntegrationsService } from '../crm-integrations/crm-integrations.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { SaveZohoAppCredentialsDto } from './dto/save-app-credentials.dto';
import { accountsBaseUrlForRegion, ZOHO_DATA_CENTERS } from './zoho-data-centers';

interface ZohoTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  api_domain?: string;
  error?: string;
}

interface ZohoOAuthState {
  organizationId: string;
  purpose: 'zoho-oauth';
}

interface ZohoAppCredentials {
  clientId: string;
  clientSecret: string;
  accountsBaseUrl: string;
}

/**
 * Zoho CRM OAuth — one connection per ORGANIZATION (unlike Outlook/Gmail's
 * per-user mailboxes), stored through IntegrationsService.connectWithOAuth
 * (authType 'oauth2') rather than a dedicated schema, since that's already
 * exactly how every other CRM provider here is modeled — see
 * auth-methods.ts's own comment on why 'oauth2' lives there, not as a new
 * parallel credential system. The OAuth *mechanics* below (authorize ->
 * signed-JWT state -> callback -> code exchange) are copied from
 * outlook.service.ts/gmail.service.ts's proven shape.
 *
 * App credentials: an organization can bring its OWN Zoho API Console app
 * (Settings -> Integrations -> Connect Zoho CRM -> credential modal, see
 * POST/GET /zoho/app-credentials below) instead of Haive's shared platform
 * app (ZOHO_CLIENT_ID/SECRET env vars) — resolveAppCredentials() always
 * prefers the organization's own saved app over the platform fallback, so
 * existing deployments that only ever used the platform app keep working
 * unchanged. This was added specifically because Zoho's app registry is
 * per-data-center with no cross-DC visibility: a platform app registered in
 * one region can never work for a customer whose Zoho org is on another, and
 * most Zoho customers already have (or can freely create) their own
 * "Server-based Application" in their own API Console.
 *
 * Multi-data-center handling: beyond the per-organization region picked at
 * app-credential-save time, Zoho's callback itself also reports
 * `accounts-server` (a documented part of its OAuth response) — used for the
 * token exchange and every future refresh, so a connection still ends up
 * correctly routed even if the saved region and the account's actual DC
 * ever disagree.
 */
@Injectable()
export class ZohoService {
  private readonly logger = new Logger(ZohoService.name);

  constructor(
    private config: ConfigService,
    private http: HttpService,
    private jwt: JwtService,
    private integrations: IntegrationsService,
    private crmIntegrations: CrmIntegrationsService,
  ) {}

  /** Organization's own saved Zoho app, falling back to the platform's
   * shared app (ZOHO_CLIENT_ID/SECRET/ACCOUNTS_BASE_URL env vars) — the
   * documented "environment variables as a fallback" precedence: org-saved
   * always wins when present, since a customer who configured their own app
   * expects it used, not silently ignored in favor of Haive's. Throws a
   * clear, user-facing error (never a raw "undefined client_id" 400 from
   * Zoho) when neither is configured. */
  private async resolveAppCredentials(organizationId: string): Promise<ZohoAppCredentials> {
    const saved = await this.integrations.resolveOAuthAppCredentials(organizationId, 'zoho');
    if (saved) {
      const accountsBaseUrl = saved.meta?.accountsServer || this.config.get<string>('integrations.zoho.accountsBaseUrl') || 'https://accounts.zoho.com';
      return { clientId: saved.clientId, clientSecret: saved.clientSecret, accountsBaseUrl };
    }

    const platformClientId = this.config.get<string>('integrations.zoho.clientId');
    const platformClientSecret = this.config.get<string>('integrations.zoho.clientSecret');
    if (!platformClientId || !platformClientSecret) {
      throw new BadRequestException({
        code: 'ZOHO_APP_CREDENTIALS_REQUIRED',
        message: 'Zoho CRM needs your Zoho API Console credentials before it can connect — enter them first.',
      });
    }
    return {
      clientId: platformClientId,
      clientSecret: platformClientSecret,
      accountsBaseUrl: this.config.get<string>('integrations.zoho.accountsBaseUrl') ?? 'https://accounts.zoho.com',
    };
  }

  /** Saves the organization's own Zoho API Console app credentials — called
   * from the "Connect Zoho CRM" credential modal before the first redirect.
   * Deliberately does not touch any existing connection/tokens (see
   * IntegrationsService.saveOAuthAppCredentials's own comment) — an org
   * replacing its app credentials after already connecting isn't
   * disconnected; the next refresh just starts using the new app. */
  async saveAppCredentials(organizationId: string, dto: SaveZohoAppCredentialsDto): Promise<{ configured: true }> {
    const accountsServer = accountsBaseUrlForRegion(dto.region, dto.accountsServerUrl);
    await this.integrations.saveOAuthAppCredentials(organizationId, 'zoho', {
      clientId: dto.clientId.trim(),
      clientSecret: dto.clientSecret.trim(),
      meta: { accountsServer, region: dto.region },
    });
    return { configured: true };
  }

  async getAppCredentialsStatus(organizationId: string) {
    const status = await this.integrations.getOAuthAppCredentialsStatus(organizationId, 'zoho');
    return { ...status, dataCenters: ZOHO_DATA_CENTERS };
  }

  async buildAuthorizeUrl(organizationId: string): Promise<string> {
    const app = await this.resolveAppCredentials(organizationId);
    const redirectUri = this.config.get<string>('integrations.zoho.redirectUri');
    const state = this.jwt.sign({ organizationId, purpose: 'zoho-oauth' } satisfies ZohoOAuthState, { expiresIn: '10m' });

    const params = new URLSearchParams({
      client_id: app.clientId,
      response_type: 'code',
      redirect_uri: redirectUri ?? '',
      // Everything the sync adapter (crm_adapters.py's ZohoAdapter) and
      // discovery actually read/write today: deals/contacts/accounts
      // records plus field metadata for mapping. access_type=offline +
      // prompt=consent are what makes Zoho actually return a refresh_token —
      // same requirement Google has, unlike Microsoft's one-time-only default.
      scope: 'ZohoCRM.modules.ALL,ZohoCRM.settings.ALL',
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `${app.accountsBaseUrl.replace(/\/$/, '')}/oauth/v2/auth?${params.toString()}`;
  }

  async handleCallback(code: string, state: string, accountsServerFromCallback?: string): Promise<void> {
    let payload: ZohoOAuthState;
    try {
      payload = this.jwt.verify<ZohoOAuthState>(state);
    } catch {
      throw new UnauthorizedException('Invalid or expired state');
    }
    if (payload.purpose !== 'zoho-oauth' || !payload.organizationId) {
      throw new UnauthorizedException('Invalid state');
    }
    const organizationId = payload.organizationId;

    const app = await this.resolveAppCredentials(organizationId);
    const accountsServer = accountsServerFromCallback || app.accountsBaseUrl;
    const tokens = await this.exchangeCode(code, accountsServer, app);

    await this.integrations.connectWithOAuth(
      organizationId,
      'zoho',
      {
        accessToken: tokens.access_token!,
        refreshToken: tokens.refresh_token!,
        expiresInSeconds: tokens.expires_in ?? 3600,
        oauthMeta: { accountsServer, apiDomain: tokens.api_domain ?? '' },
      },
      { skipSync: true },
    );

    // Same "prove it works before keeping it" contract every other CRM's
    // connect() already gives the customer (see CrmIntegrationsService.connect)
    // — a redirect-based OAuth flow has no synchronous response to carry a
    // discovery result back in, so this plays that role here instead.
    try {
      const discovery = await this.crmIntegrations.rediscover(organizationId, 'zoho');
      if (discovery.status !== 'ok') {
        throw new BadRequestException(discovery.message ?? 'Zoho CRM could not be verified.');
      }
    } catch (err) {
      await this.integrations.disconnect(organizationId, 'zoho');
      this.logger.warn(`Zoho post-connect discovery failed for org ${organizationId}: ${(err as Error).message}`);
      throw err;
    }
  }

  private async exchangeCode(code: string, accountsServer: string, app: ZohoAppCredentials): Promise<ZohoTokenResponse> {
    const redirectUri = this.config.get<string>('integrations.zoho.redirectUri');

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: app.clientId,
      client_secret: app.clientSecret,
      redirect_uri: redirectUri ?? '',
      code,
    });

    const { data } = await firstValueFrom(
      this.http.post<ZohoTokenResponse>(`${accountsServer.replace(/\/$/, '')}/oauth/v2/token`, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    );
    if (!data.access_token || !data.refresh_token) {
      throw new Error(
        data.error ??
          'Zoho did not return an access/refresh token pair — check that access_type=offline and prompt=consent were sent, and that this is a first-time consent (Zoho only issues a refresh_token on first authorization unless the user is re-prompted).',
      );
    }
    return data;
  }
}
