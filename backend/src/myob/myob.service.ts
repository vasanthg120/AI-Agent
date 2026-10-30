import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { firstValueFrom } from 'rxjs';
import { IntegrationsService } from '../integrations/integrations.service';

const PLATFORM_INTEGRATION_SCOPE = 'platform';
const MYOB_API_BASE = 'https://api.myob.com/accountright';

// Read-focused scopes only — no sme-payroll (a separate, more sensitive
// scope this integration has no reason to request) and no write-oriented
// scope beyond what these grant by default (MYOB's scopes are granted per
// feature-area with no separate read-only variant — confirmed from MYOB's
// own scopes page — so staying read-only is enforced by never configuring
// a write endpoint via ResourceEndpointBuilder, not by the OAuth grant
// itself).
const MYOB_SCOPES = 'sme-company-settings sme-sales sme-contacts-customer sme-general-ledger';

interface MyobTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface MyobOAuthState {
  organizationId: string;
  purpose: 'myob-oauth';
}

interface MyobAppCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * MYOB OAuth — one connection per ORGANIZATION, platform-wide shared app
 * (same reasoning as xero.service.ts — MYOB has no regional app-registry
 * fragmentation to justify a per-org "bring your own app" pattern).
 *
 * Two things no other provider on this page needs:
 *
 * 1. No post-connect "which company file" discovery call — MYOB's redirect
 *    itself returns the company file id (businessId) alongside the
 *    authorization code, so handleCallback already knows it and bakes it
 *    straight into the stored baseUrl (https://api.myob.com/accountright/
 *    {businessId}) — confirmed from MYOB's own current docs
 *    (developer.myob.com/api/myob-business-api), not assumed.
 * 2. A SEPARATE company-file username/password pair, required on every API
 *    call as the x-myobapi-cftoken header (Base64 "username:password") in
 *    addition to the OAuth access token — see
 *    IntegrationsService.saveSecondaryCredentials/resolveAuth's
 *    secondaryCredentials. The OAuth connection is real and usable the
 *    moment handleCallback finishes, but every actual data call fails with
 *    a clear MYOB auth error until this second pair is entered too — never
 *    silently treated as "fully connected" before then (see getStatus's
 *    needsCompanyFileCredentials).
 */
@Injectable()
export class MyobService {
  private readonly logger = new Logger(MyobService.name);

  constructor(
    private config: ConfigService,
    private http: HttpService,
    private jwt: JwtService,
    private integrations: IntegrationsService,
  ) {}

  private async resolveAppCredentials(): Promise<MyobAppCredentials> {
    const saved = await this.integrations.resolveOAuthAppCredentials(PLATFORM_INTEGRATION_SCOPE, 'myob');
    if (saved) return saved;

    const clientId = this.config.get<string>('integrations.myob.clientId');
    const clientSecret = this.config.get<string>('integrations.myob.clientSecret');
    if (!clientId || !clientSecret) {
      throw new BadRequestException({
        code: 'MYOB_APP_CREDENTIALS_REQUIRED',
        message: 'MYOB is not available yet — ask your Haive administrator to configure MYOB OAuth.',
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
    const redirectUri = this.config.get<string>('integrations.myob.redirectUri');
    const state = this.jwt.sign({ organizationId, purpose: 'myob-oauth' } satisfies MyobOAuthState, { expiresIn: '10m' });

    const params = new URLSearchParams({
      client_id: app.clientId,
      redirect_uri: redirectUri ?? '',
      response_type: 'code',
      scope: MYOB_SCOPES,
      // Required to guarantee the redirect actually includes businessId —
      // see MYOB's own OAuth guide (post-March-2025 update).
      prompt: 'consent',
      state,
    });
    return `https://secure.myob.com/oauth2/account/authorize?${params.toString()}`;
  }

  async handleCallback(code: string, businessId: string, state: string): Promise<void> {
    let payload: MyobOAuthState;
    try {
      payload = this.jwt.verify<MyobOAuthState>(state);
    } catch {
      throw new UnauthorizedException('Invalid or expired state');
    }
    if (payload.purpose !== 'myob-oauth' || !payload.organizationId) {
      throw new UnauthorizedException('Invalid state');
    }
    if (!businessId) {
      throw new BadRequestException('MYOB did not return a company file id for this authorization.');
    }
    const organizationId = payload.organizationId;

    const app = await this.resolveAppCredentials();
    const tokens = await this.exchangeCode(code, app);

    await this.integrations.connectWithOAuth(
      organizationId,
      'myob',
      {
        accessToken: tokens.access_token!,
        refreshToken: tokens.refresh_token!,
        expiresInSeconds: tokens.expires_in ?? 1200,
        baseUrl: `${MYOB_API_BASE}/${businessId}`,
        // Needed again on every later API call (x-myobapi-key), not just
        // this authorize request — see dynamic-executor.service.ts.
        oauthMeta: { myobClientId: app.clientId },
      },
      { skipSync: true },
    );
  }

  /** The second credential pair MYOB requires beyond OAuth — see this
   * service's own doc comment. Requires the OAuth connection to already
   * exist (same "finish an existing connection" shape as
   * xero.service.ts's selectTenant), never creates one on its own. */
  async saveCompanyFileCredentials(organizationId: string, username: string, password: string): Promise<void> {
    const auth = await this.integrations.resolveAuth(organizationId, 'myob');
    if (!auth) throw new BadRequestException('MYOB isn’t connected yet — connect it first.');
    await this.integrations.saveSecondaryCredentials(organizationId, 'myob', { username, password });
  }

  async getStatus(organizationId: string): Promise<{ connected: boolean; needsCompanyFileCredentials: boolean }> {
    const auth = await this.integrations.resolveAuth(organizationId, 'myob');
    if (!auth) return { connected: false, needsCompanyFileCredentials: false };
    return { connected: true, needsCompanyFileCredentials: !auth.secondaryCredentials };
  }

  async disconnect(organizationId: string): Promise<void> {
    await this.integrations.disconnect(organizationId, 'myob');
  }

  private async exchangeCode(code: string, app: MyobAppCredentials): Promise<MyobTokenResponse> {
    const redirectUri = this.config.get<string>('integrations.myob.redirectUri');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: app.clientId,
      client_secret: app.clientSecret,
      scope: MYOB_SCOPES,
      code,
      redirect_uri: redirectUri ?? '',
    });

    // Confirmed from MYOB's own docs: the token endpoint is the SAME path
    // as the authorize one above, just POSTed to instead of GETted — not a
    // typo, MYOB genuinely reuses /oauth2/v1/authorize for token exchange.
    const { data } = await firstValueFrom(
      this.http.post<MyobTokenResponse>('https://secure.myob.com/oauth2/v1/authorize', body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    );
    if (!data.access_token || !data.refresh_token) {
      throw new Error(data.error_description ?? data.error ?? 'MYOB did not return an access/refresh token pair.');
    }
    return data;
  }
}
