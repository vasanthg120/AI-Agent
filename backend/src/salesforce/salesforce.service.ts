import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { firstValueFrom } from 'rxjs';
import { CrmIntegrationsService } from '../crm-integrations/crm-integrations.service';
import { IntegrationsService } from '../integrations/integrations.service';

interface SalesforceTokenResponse {
  access_token?: string;
  refresh_token?: string;
  instance_url?: string;
  error?: string;
  error_description?: string;
}

interface SalesforceOAuthState {
  organizationId: string;
  purpose: 'salesforce-oauth';
}

/**
 * Salesforce OAuth — one connection per ORGANIZATION (unlike Outlook/Gmail's
 * per-user mailboxes), stored through IntegrationsService.connectWithOAuth
 * (authType 'oauth2') rather than a dedicated schema — same reasoning as
 * zoho.service.ts. The OAuth *mechanics* (authorize -> signed-JWT state ->
 * callback -> code exchange) are copied from outlook.service.ts/
 * gmail.service.ts's proven shape.
 *
 * instance_url handling: unlike Zoho's multi-data-center problem, Salesforce
 * has one stable login entry point (login.salesforce.com) that works for
 * both production AND sandbox orgs — Salesforce itself redirects a sandbox
 * user to test.salesforce.com mid-flow when needed. What genuinely differs
 * per customer is instance_url (e.g. https://my-org.my.salesforce.com) —
 * every subsequent API call must target it, never a fixed host, and it's
 * only known from the token response itself (see
 * IntegrationsService.refreshOAuthToken and crm_adapters.py's
 * SalesforceAdapter._resolve_base_url for where it's used after connecting).
 */
@Injectable()
export class SalesforceService {
  private readonly logger = new Logger(SalesforceService.name);

  constructor(
    private config: ConfigService,
    private http: HttpService,
    private jwt: JwtService,
    private integrations: IntegrationsService,
    private crmIntegrations: CrmIntegrationsService,
  ) {}

  buildAuthorizeUrl(organizationId: string): string {
    const clientId = this.config.get<string>('integrations.salesforce.clientId');
    const redirectUri = this.config.get<string>('integrations.salesforce.redirectUri');
    const authBaseUrl = this.config.get<string>('integrations.salesforce.authBaseUrl') ?? 'https://login.salesforce.com';
    const state = this.jwt.sign({ organizationId, purpose: 'salesforce-oauth' } satisfies SalesforceOAuthState, { expiresIn: '10m' });

    const params = new URLSearchParams({
      client_id: clientId ?? '',
      response_type: 'code',
      redirect_uri: redirectUri ?? '',
      // 'api' covers the REST/query calls crm_adapters.py's SalesforceAdapter
      // makes; 'refresh_token' (classic scope name, still supported
      // alongside the newer 'offline_access') is what makes Salesforce
      // actually issue a refresh token — without it the connection would
      // silently stop working the moment the first session expires.
      scope: 'api refresh_token',
      state,
    });
    return `${authBaseUrl.replace(/\/$/, '')}/services/oauth2/authorize?${params.toString()}`;
  }

  async handleCallback(code: string, state: string): Promise<void> {
    let payload: SalesforceOAuthState;
    try {
      payload = this.jwt.verify<SalesforceOAuthState>(state);
    } catch {
      throw new UnauthorizedException('Invalid or expired state');
    }
    if (payload.purpose !== 'salesforce-oauth' || !payload.organizationId) {
      throw new UnauthorizedException('Invalid state');
    }
    const organizationId = payload.organizationId;

    const tokens = await this.exchangeCode(code);

    await this.integrations.connectWithOAuth(
      organizationId,
      'salesforce',
      {
        accessToken: tokens.access_token!,
        refreshToken: tokens.refresh_token!,
        // Salesforce doesn't return expires_in on the token response — its
        // session lifetime is governed by the org's own Session Settings
        // (admin-configured, commonly 2-24h), not a fixed OAuth TTL. Using
        // the same conservative 2h re-check window refreshOAuthToken()/
        // oauth_refresh.py use on every refresh keeps this consistent rather
        // than guessing a longer window that might outlive a strict org
        // policy.
        expiresInSeconds: 7200,
        oauthMeta: { instanceUrl: tokens.instance_url ?? '' },
      },
      { skipSync: true },
    );

    try {
      const discovery = await this.crmIntegrations.rediscover(organizationId, 'salesforce');
      if (discovery.status !== 'ok') {
        throw new BadRequestException(discovery.message ?? 'Salesforce could not be verified.');
      }
    } catch (err) {
      await this.integrations.disconnect(organizationId, 'salesforce');
      this.logger.warn(`Salesforce post-connect discovery failed for org ${organizationId}: ${(err as Error).message}`);
      throw err;
    }
  }

  private async exchangeCode(code: string): Promise<SalesforceTokenResponse> {
    const clientId = this.config.get<string>('integrations.salesforce.clientId');
    const clientSecret = this.config.get<string>('integrations.salesforce.clientSecret');
    const redirectUri = this.config.get<string>('integrations.salesforce.redirectUri');
    const authBaseUrl = this.config.get<string>('integrations.salesforce.authBaseUrl') ?? 'https://login.salesforce.com';

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId ?? '',
      client_secret: clientSecret ?? '',
      redirect_uri: redirectUri ?? '',
      code,
    });

    const { data } = await firstValueFrom(
      this.http.post<SalesforceTokenResponse>(`${authBaseUrl.replace(/\/$/, '')}/services/oauth2/token`, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    );
    if (!data.access_token || !data.refresh_token || !data.instance_url) {
      throw new Error(
        data.error_description ??
          data.error ??
          'Salesforce did not return a complete token response (access token, refresh token and instance URL are all required).',
      );
    }
    return data;
  }
}
