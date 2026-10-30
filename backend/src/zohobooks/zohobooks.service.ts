import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { firstValueFrom } from 'rxjs';
import { IntegrationsService } from '../integrations/integrations.service';
import { SaveZohoAppCredentialsDto } from '../zoho/dto/save-app-credentials.dto';
import { accountsBaseUrlForRegion, ZOHO_DATA_CENTERS } from '../zoho/zoho-data-centers';

interface ZohoTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  api_domain?: string;
  error?: string;
}

interface ZohoBooksOrganization {
  organization_id: string;
  name: string;
}

interface ZohoOAuthState {
  organizationId: string;
  purpose: 'zohobooks-oauth';
}

interface ZohoAppCredentials {
  clientId: string;
  clientSecret: string;
  accountsBaseUrl: string;
}

export interface ZohoBooksOrgOption {
  organizationId: string;
  name: string;
}

/**
 * Zoho Books OAuth — one connection per Haive ORGANIZATION, stored through
 * IntegrationsService.connectWithOAuth (authType 'oauth2'), same shape as
 * zoho.service.ts (Zoho CRM). Reuses that module's data-center list and
 * "bring your own app" DTO (both are already generic, not CRM-specific) but
 * is a FULLY SEPARATE credential — provider 'zohobooks', never sharing an
 * organization's Zoho CRM row — per the explicit product requirement that
 * Books be implemented independently of the existing CRM integration. An
 * organization connecting both brings two Zoho API Console app
 * registrations (even if, in Zoho's own console, an admin happens to reuse
 * the same one — Haive never assumes that).
 *
 * One extra step neither Outlook/Gmail/Xero need: Zoho's own "organization"
 * concept (a Zoho Books account can hold several books/companies) — handled
 * the same way as Xero's multi-tenant case (handleCallback connects
 * immediately; selectBooksOrganization finishes it if more than one).
 */
@Injectable()
export class ZohoBooksService {
  private readonly logger = new Logger(ZohoBooksService.name);

  constructor(
    private config: ConfigService,
    private http: HttpService,
    private jwt: JwtService,
    private integrations: IntegrationsService,
  ) {}

  private async resolveAppCredentials(organizationId: string): Promise<ZohoAppCredentials> {
    const saved = await this.integrations.resolveOAuthAppCredentials(organizationId, 'zohobooks');
    if (saved) {
      const accountsBaseUrl =
        saved.meta?.accountsServer || this.config.get<string>('integrations.zohobooks.accountsBaseUrl') || 'https://accounts.zoho.com';
      return { clientId: saved.clientId, clientSecret: saved.clientSecret, accountsBaseUrl };
    }

    const platformClientId = this.config.get<string>('integrations.zohobooks.clientId');
    const platformClientSecret = this.config.get<string>('integrations.zohobooks.clientSecret');
    if (!platformClientId || !platformClientSecret) {
      throw new BadRequestException({
        code: 'ZOHOBOOKS_APP_CREDENTIALS_REQUIRED',
        message: 'Zoho Books needs your Zoho API Console credentials before it can connect — enter them first.',
      });
    }
    return {
      clientId: platformClientId,
      clientSecret: platformClientSecret,
      accountsBaseUrl: this.config.get<string>('integrations.zohobooks.accountsBaseUrl') ?? 'https://accounts.zoho.com',
    };
  }

  async saveAppCredentials(organizationId: string, dto: SaveZohoAppCredentialsDto): Promise<{ configured: true }> {
    const accountsServer = accountsBaseUrlForRegion(dto.region, dto.accountsServerUrl);
    await this.integrations.saveOAuthAppCredentials(organizationId, 'zohobooks', {
      clientId: dto.clientId.trim(),
      clientSecret: dto.clientSecret.trim(),
      meta: { accountsServer, region: dto.region },
    });
    return { configured: true };
  }

  async getAppCredentialsStatus(organizationId: string) {
    const status = await this.integrations.getOAuthAppCredentialsStatus(organizationId, 'zohobooks');
    return { ...status, dataCenters: ZOHO_DATA_CENTERS };
  }

  async buildAuthorizeUrl(organizationId: string): Promise<string> {
    const app = await this.resolveAppCredentials(organizationId);
    const redirectUri = this.config.get<string>('integrations.zohobooks.redirectUri');
    const state = this.jwt.sign({ organizationId, purpose: 'zohobooks-oauth' } satisfies ZohoOAuthState, { expiresIn: '10m' });

    const params = new URLSearchParams({
      client_id: app.clientId,
      response_type: 'code',
      redirect_uri: redirectUri ?? '',
      // Read-only scope only — write operations stay disabled until
      // explicit authorization/confirmation/auditing exist for them.
      scope: 'ZohoBooks.fullaccess.READ',
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `${app.accountsBaseUrl.replace(/\/$/, '')}/oauth/v2/auth?${params.toString()}`;
  }

  async handleCallback(code: string, state: string, accountsServerFromCallback?: string): Promise<{ orgs: ZohoBooksOrgOption[]; needsSelection: boolean }> {
    let payload: ZohoOAuthState;
    try {
      payload = this.jwt.verify<ZohoOAuthState>(state);
    } catch {
      throw new UnauthorizedException('Invalid or expired state');
    }
    if (payload.purpose !== 'zohobooks-oauth' || !payload.organizationId) {
      throw new UnauthorizedException('Invalid state');
    }
    const organizationId = payload.organizationId;

    const app = await this.resolveAppCredentials(organizationId);
    const accountsServer = accountsServerFromCallback || app.accountsBaseUrl;
    const tokens = await this.exchangeCode(code, accountsServer, app);
    const apiDomain = tokens.api_domain ?? '';

    const zohoOrgs = await this.listOrganizations(apiDomain, tokens.access_token!);
    if (zohoOrgs.length === 0) {
      throw new BadRequestException('Zoho Books did not report any organisation for this account.');
    }
    const orgs = zohoOrgs.map((o) => ({ organizationId: o.organization_id, name: o.name }));
    const single = zohoOrgs.length === 1 ? zohoOrgs[0] : undefined;

    await this.integrations.connectWithOAuth(
      organizationId,
      'zohobooks',
      {
        accessToken: tokens.access_token!,
        refreshToken: tokens.refresh_token!,
        expiresInSeconds: tokens.expires_in ?? 3600,
        oauthMeta: {
          accountsServer,
          booksApiDomain: apiDomain,
          organizations: JSON.stringify(orgs),
          ...(single ? { booksOrganizationId: single.organization_id, booksOrganizationName: single.name } : {}),
        },
      },
      { skipSync: true },
    );

    return { orgs, needsSelection: zohoOrgs.length > 1 };
  }

  /** Finishes a multi-organisation connection — mirrors xero.service.ts's
   * selectTenant exactly (same reasoning: the connection already exists so
   * refresh/disconnect already work, this only narrows which Zoho Books
   * "organization" requests target). */
  async selectOrganization(organizationId: string, booksOrganizationId: string): Promise<void> {
    const auth = await this.integrations.resolveAuth(organizationId, 'zohobooks');
    if (!auth) throw new BadRequestException('Zoho Books isn’t connected yet.');
    const orgs = JSON.parse(auth.oauthMeta?.organizations ?? '[]') as ZohoBooksOrgOption[];
    const match = orgs.find((o) => o.organizationId === booksOrganizationId);
    if (!match) throw new BadRequestException('That organisation wasn’t part of this Zoho Books authorization.');
    await this.integrations.mergeOAuthMeta(organizationId, 'zohobooks', {
      booksOrganizationId: match.organizationId,
      booksOrganizationName: match.name,
    });
  }

  async getStatus(organizationId: string): Promise<{ connected: boolean; needsSelection: boolean; organizationName?: string; orgs?: ZohoBooksOrgOption[] }> {
    const auth = await this.integrations.resolveAuth(organizationId, 'zohobooks');
    if (!auth) return { connected: false, needsSelection: false };
    const orgs = JSON.parse(auth.oauthMeta?.organizations ?? '[]') as ZohoBooksOrgOption[];
    return {
      connected: true,
      needsSelection: !auth.oauthMeta?.booksOrganizationId,
      organizationName: auth.oauthMeta?.booksOrganizationName,
      orgs: orgs.length > 1 ? orgs : undefined,
    };
  }

  async disconnect(organizationId: string): Promise<void> {
    await this.integrations.disconnect(organizationId, 'zohobooks');
  }

  private async exchangeCode(code: string, accountsServer: string, app: ZohoAppCredentials): Promise<ZohoTokenResponse> {
    const redirectUri = this.config.get<string>('integrations.zohobooks.redirectUri');
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
          'Zoho Books did not return an access/refresh token pair — check that access_type=offline and prompt=consent were sent, and that this is a first-time consent.',
      );
    }
    return data;
  }

  private async listOrganizations(apiDomain: string, accessToken: string): Promise<ZohoBooksOrganization[]> {
    const { data } = await firstValueFrom(
      this.http.get<{ organizations?: ZohoBooksOrganization[] }>(`${apiDomain.replace(/\/$/, '')}/books/v3/organizations`, {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      }),
    );
    return data.organizations ?? [];
  }
}
