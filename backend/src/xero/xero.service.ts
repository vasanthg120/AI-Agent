import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { firstValueFrom } from 'rxjs';
import { IntegrationsService } from '../integrations/integrations.service';

const PLATFORM_INTEGRATION_SCOPE = 'platform';
const XERO_API_BASE_URL = 'https://api.xero.com/api.xro/2.0';

// Read-only scopes only — no accounting.transactions / accounting.contacts
// write scope requested. Mutating operations are deliberately not built yet
// (per the product requirement: writes stay disabled until explicit
// authorization, confirmation, and auditing exist for them).
const XERO_SCOPES = 'offline_access accounting.transactions.read accounting.contacts.read accounting.reports.read';

interface XeroTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface XeroConnection {
  tenantId: string;
  tenantName: string;
  tenantType: string;
}

interface XeroOAuthState {
  organizationId: string;
  purpose: 'xero-oauth';
}

interface XeroAppCredentials {
  clientId: string;
  clientSecret: string;
}

export interface XeroTenantOption {
  tenantId: string;
  tenantName: string;
}

/**
 * Xero accounting OAuth — one connection per ORGANIZATION (same shape as
 * Zoho/Salesforce — see zoho.service.ts), stored through
 * IntegrationsService.connectWithOAuth (authType 'oauth2') rather than a
 * dedicated schema.
 *
 * Unlike Zoho, Xero has ONE global API host with no per-region data-center
 * fragmentation — so this uses the Gmail-style single platform-wide app
 * (resolveAppCredentials below), not Zoho's per-organization "bring your own
 * app" pattern. A Xero login can authorize access to more than one Xero
 * "tenant" (organisation) at once; when it does, the connection is written
 * immediately (so refresh/disconnect already work) but without a selected
 * tenantId yet — selectTenant() below finishes it with a narrow oauthMeta
 * update (IntegrationsService.mergeOAuthMeta), never re-sending tokens.
 */
@Injectable()
export class XeroService {
  private readonly logger = new Logger(XeroService.name);

  constructor(
    private config: ConfigService,
    private http: HttpService,
    private jwt: JwtService,
    private integrations: IntegrationsService,
  ) {}

  private async resolveAppCredentials(): Promise<XeroAppCredentials> {
    const saved = await this.integrations.resolveOAuthAppCredentials(PLATFORM_INTEGRATION_SCOPE, 'xero');
    if (saved) return saved;

    const clientId = this.config.get<string>('integrations.xero.clientId');
    const clientSecret = this.config.get<string>('integrations.xero.clientSecret');
    if (!clientId || !clientSecret) {
      throw new BadRequestException({
        code: 'XERO_APP_CREDENTIALS_REQUIRED',
        message: 'Xero is not available yet — ask your Haive administrator to configure Xero OAuth.',
      });
    }
    return { clientId, clientSecret };
  }

  async isAppConfigured(): Promise<boolean> {
    try {
      await this.resolveAppCredentials();
      return true;
    } catch {
      return false;
    }
  }

  async buildAuthorizeUrl(organizationId: string): Promise<string> {
    const app = await this.resolveAppCredentials();
    const redirectUri = this.config.get<string>('integrations.xero.redirectUri');
    const state = this.jwt.sign({ organizationId, purpose: 'xero-oauth' } satisfies XeroOAuthState, { expiresIn: '10m' });

    const params = new URLSearchParams({
      client_id: app.clientId,
      response_type: 'code',
      redirect_uri: redirectUri ?? '',
      scope: XERO_SCOPES,
      state,
    });
    return `https://login.xero.com/identity/connect/authorize?${params.toString()}`;
  }

  async handleCallback(code: string, state: string): Promise<{ tenants: XeroTenantOption[]; needsSelection: boolean }> {
    let payload: XeroOAuthState;
    try {
      payload = this.jwt.verify<XeroOAuthState>(state);
    } catch {
      throw new UnauthorizedException('Invalid or expired state');
    }
    if (payload.purpose !== 'xero-oauth' || !payload.organizationId) {
      throw new UnauthorizedException('Invalid state');
    }
    const organizationId = payload.organizationId;

    const app = await this.resolveAppCredentials();
    const tokens = await this.exchangeCode(code, app);
    const connections = await this.listConnections(tokens.access_token!);
    if (connections.length === 0) {
      throw new BadRequestException('Xero did not report any authorized organisation for this connection.');
    }

    const tenants = connections.map((c) => ({ tenantId: c.tenantId, tenantName: c.tenantName }));
    const singleTenant = connections.length === 1 ? connections[0] : undefined;

    await this.integrations.connectWithOAuth(
      organizationId,
      'xero',
      {
        accessToken: tokens.access_token!,
        refreshToken: tokens.refresh_token!,
        expiresInSeconds: tokens.expires_in ?? 1800,
        baseUrl: XERO_API_BASE_URL,
        oauthMeta: {
          tenants: JSON.stringify(tenants),
          ...(singleTenant ? { tenantId: singleTenant.tenantId, tenantName: singleTenant.tenantName } : {}),
        },
      },
      { skipSync: true },
    );

    return { tenants, needsSelection: connections.length > 1 };
  }

  /** Finishes a multi-tenant connection — the credential row already exists
   * (handleCallback above wrote it), this only picks which discovered
   * tenant it talks to. Re-validates against the tenant list stored at
   * connect time rather than trusting the id blindly. */
  async selectTenant(organizationId: string, tenantId: string): Promise<void> {
    const auth = await this.integrations.resolveAuth(organizationId, 'xero');
    if (!auth) throw new BadRequestException('Xero isn’t connected yet.');
    const tenants = JSON.parse(auth.oauthMeta?.tenants ?? '[]') as XeroTenantOption[];
    const match = tenants.find((t) => t.tenantId === tenantId);
    if (!match) throw new BadRequestException('That organisation wasn’t part of this Xero authorization.');
    await this.integrations.mergeOAuthMeta(organizationId, 'xero', { tenantId: match.tenantId, tenantName: match.tenantName });
  }

  async getStatus(organizationId: string): Promise<{ connected: boolean; needsSelection: boolean; tenantName?: string; tenants?: XeroTenantOption[] }> {
    const auth = await this.integrations.resolveAuth(organizationId, 'xero');
    if (!auth) return { connected: false, needsSelection: false };
    const tenants = JSON.parse(auth.oauthMeta?.tenants ?? '[]') as XeroTenantOption[];
    return {
      connected: true,
      needsSelection: !auth.oauthMeta?.tenantId,
      tenantName: auth.oauthMeta?.tenantName,
      tenants: tenants.length > 1 ? tenants : undefined,
    };
  }

  async disconnect(organizationId: string): Promise<void> {
    await this.integrations.disconnect(organizationId, 'xero');
  }

  private async exchangeCode(code: string, app: XeroAppCredentials): Promise<XeroTokenResponse> {
    const redirectUri = this.config.get<string>('integrations.xero.redirectUri');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: app.clientId,
      client_secret: app.clientSecret,
      redirect_uri: redirectUri ?? '',
      code,
    });

    const { data } = await firstValueFrom(
      this.http.post<XeroTokenResponse>('https://identity.xero.com/connect/token', body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    );
    if (!data.access_token || !data.refresh_token) {
      throw new Error(data.error_description ?? data.error ?? 'Xero did not return an access/refresh token pair.');
    }
    return data;
  }

  private async listConnections(accessToken: string): Promise<XeroConnection[]> {
    const { data } = await firstValueFrom(
      this.http.get<XeroConnection[]>('https://api.xero.com/connections', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    );
    return data;
  }
}
