import { JwtService } from '@nestjs/jwt';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { of } from 'rxjs';
import { ZohoService } from './zoho.service';

// Unit-level (no Mongo): buildAuthorizeUrl/handleCallback's real persistence
// is IntegrationsService.connectWithOAuth/saveOAuthAppCredentials's job,
// already covered against a real Mongo in
// integrations/integrations-oauth.spec.ts. This is specifically about the
// OAuth mechanics ZohoService itself owns: app-credential precedence
// (organization's own app vs. the platform's shared app), state
// signing/verification, the multi-data-center accounts-server handling, and
// the "roll back if the post-connect check fails" contract every other CRM's
// connect() already gives customers.
describe('ZohoService', () => {
  const jwt = new JwtService({ secret: 'test-secret' });
  const platformConfig: Record<string, string> = {
    'integrations.zoho.clientId': 'platform-client-id',
    'integrations.zoho.clientSecret': 'platform-client-secret',
    'integrations.zoho.redirectUri': 'http://localhost:3000/zoho/callback',
    'integrations.zoho.accountsBaseUrl': 'https://accounts.zoho.com',
  };
  const config = { get: (key: string) => platformConfig[key] } as never;
  const noPlatformAppConfig = {
    get: (key: string) => (key === 'integrations.zoho.redirectUri' ? platformConfig[key] : undefined),
  } as never;

  function makeService(
    opts: { config?: typeof config; orgAppCredentials?: { clientId: string; clientSecret: string; meta?: Record<string, string> } | null } = {},
  ) {
    const http = { post: jest.fn() };
    const integrations = {
      connectWithOAuth: jest.fn().mockResolvedValue({ connected: true }),
      disconnect: jest.fn().mockResolvedValue(undefined),
      saveOAuthAppCredentials: jest.fn().mockResolvedValue(undefined),
      getOAuthAppCredentialsStatus: jest.fn(),
      resolveOAuthAppCredentials: jest.fn().mockResolvedValue(opts.orgAppCredentials ?? null),
    };
    const crmIntegrations = { rediscover: jest.fn().mockResolvedValue({ status: 'ok', modules: {} }) };
    const service = new ZohoService(opts.config ?? config, http as never, jwt, integrations as never, crmIntegrations as never);
    return { service, http, integrations, crmIntegrations };
  }

  describe('app-credential precedence', () => {
    it('buildAuthorizeUrl uses the platform app when the organization has not configured its own', async () => {
      const { service, integrations } = makeService();
      const url = new URL(await service.buildAuthorizeUrl('org-1'));
      expect(url.searchParams.get('client_id')).toBe('platform-client-id');
      expect(integrations.resolveOAuthAppCredentials).toHaveBeenCalledWith('org-1', 'zoho');
    });

    it('buildAuthorizeUrl prefers the organization\'s own saved app over the platform app', async () => {
      const { service } = makeService({
        orgAppCredentials: { clientId: 'org-client-id', clientSecret: 'org-secret', meta: { accountsServer: 'https://accounts.zoho.in' } },
      });
      const url = new URL(await service.buildAuthorizeUrl('org-1'));
      expect(url.searchParams.get('client_id')).toBe('org-client-id');
      expect(url.origin + url.pathname).toBe('https://accounts.zoho.in/oauth/v2/auth');
    });

    it('buildAuthorizeUrl throws a clear, user-facing error when neither the org nor the platform has credentials configured', async () => {
      const { service } = makeService({ config: noPlatformAppConfig });
      await expect(service.buildAuthorizeUrl('org-1')).rejects.toThrow(BadRequestException);
      await expect(service.buildAuthorizeUrl('org-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'ZOHO_APP_CREDENTIALS_REQUIRED' }),
      });
    });
  });

  describe('saveAppCredentials', () => {
    it('resolves the region to the correct accounts server and persists via IntegrationsService', async () => {
      const { service, integrations } = makeService();
      await service.saveAppCredentials('org-1', { clientId: ' my-client-id ', clientSecret: ' my-secret ', region: 'in' });
      expect(integrations.saveOAuthAppCredentials).toHaveBeenCalledWith('org-1', 'zoho', {
        clientId: 'my-client-id',
        clientSecret: 'my-secret',
        meta: { accountsServer: 'https://accounts.zoho.in', region: 'in' },
      });
    });

    it('accepts a custom accounts-server URL for region "other"', async () => {
      const { service, integrations } = makeService();
      await service.saveAppCredentials('org-1', {
        clientId: 'id',
        clientSecret: 'secret',
        region: 'other',
        accountsServerUrl: 'https://accounts.zoho.com.cn',
      });
      expect(integrations.saveOAuthAppCredentials).toHaveBeenCalledWith(
        'org-1',
        'zoho',
        expect.objectContaining({ meta: { accountsServer: 'https://accounts.zoho.com.cn', region: 'other' } }),
      );
    });
  });

  it('buildAuthorizeUrl requests offline access + consent, and signs organizationId into state', async () => {
    const { service } = makeService();
    const url = new URL(await service.buildAuthorizeUrl('org-1'));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    const state = jwt.verify<{ organizationId: string; purpose: string }>(url.searchParams.get('state')!);
    expect(state).toMatchObject({ organizationId: 'org-1', purpose: 'zoho-oauth' });
  });

  it('handleCallback rejects a state signed for a different purpose (e.g. a reused/forged token)', async () => {
    const { service, integrations } = makeService();
    const wrongPurposeState = jwt.sign({ organizationId: 'org-1', purpose: 'salesforce-oauth' });
    await expect(service.handleCallback('code', wrongPurposeState)).rejects.toThrow(UnauthorizedException);
    expect(integrations.connectWithOAuth).not.toHaveBeenCalled();
  });

  it('handleCallback rejects a garbage/expired state before ever exchanging the code', async () => {
    const { service, http } = makeService();
    await expect(service.handleCallback('code', 'not-a-real-jwt')).rejects.toThrow(UnauthorizedException);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('on success: exchanges the code against the accounts-server Zoho itself reported, using the organization\'s own app credentials, and runs discovery', async () => {
    const { service, http, integrations } = makeService({
      orgAppCredentials: { clientId: 'org-client-id', clientSecret: 'org-secret' },
    });
    http.post.mockReturnValue(of({ data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, api_domain: 'https://www.zohoapis.eu' } }));

    const state = jwt.sign({ organizationId: 'org-1', purpose: 'zoho-oauth' });
    await service.handleCallback('auth-code', state, 'https://accounts.zoho.eu');

    const [url, body] = http.post.mock.calls[0];
    expect(url).toBe('https://accounts.zoho.eu/oauth/v2/token');
    expect(String(body)).toContain('client_id=org-client-id');
    expect(String(body)).toContain('client_secret=org-secret');
    expect(integrations.connectWithOAuth).toHaveBeenCalledWith(
      'org-1',
      'zoho',
      expect.objectContaining({ accessToken: 'at', refreshToken: 'rt', expiresInSeconds: 3600 }),
      { skipSync: true },
    );
    expect(integrations.disconnect).not.toHaveBeenCalled();
  });

  it('rolls back exactly once when the post-connect discovery check fails', async () => {
    const { service, http, integrations, crmIntegrations } = makeService();
    http.post.mockReturnValue(of({ data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } }));
    crmIntegrations.rediscover.mockResolvedValue({ status: 'error', message: 'denied' });

    const state = jwt.sign({ organizationId: 'org-1', purpose: 'zoho-oauth' });
    await expect(service.handleCallback('auth-code', state)).rejects.toThrow();
    expect(integrations.disconnect).toHaveBeenCalledWith('org-1', 'zoho');
    expect(integrations.disconnect).toHaveBeenCalledTimes(1);
  });

  it('rolls back when Zoho never returns a refresh token (e.g. access_type/prompt were not honored)', async () => {
    const { service, http, integrations } = makeService();
    http.post.mockReturnValue(of({ data: { access_token: 'at' } }));

    const state = jwt.sign({ organizationId: 'org-1', purpose: 'zoho-oauth' });
    await expect(service.handleCallback('auth-code', state)).rejects.toThrow();
    expect(integrations.connectWithOAuth).not.toHaveBeenCalled();
  });
});
