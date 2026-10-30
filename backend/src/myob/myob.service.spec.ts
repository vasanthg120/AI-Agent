import { JwtService } from '@nestjs/jwt';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { of } from 'rxjs';
import { MyobService } from './myob.service';

// Same split as xero.service.spec.ts/zohobooks.service.spec.ts: unit-level,
// IntegrationsService mocked. Specific to MYOB: no discovery call (businessId
// comes straight from the callback params, confirmed from MYOB's own docs),
// and the separate company-file-credentials step no other provider needs.
describe('MyobService', () => {
  const jwt = new JwtService({ secret: 'test-secret' });
  const platformConfig: Record<string, string> = {
    'integrations.myob.clientId': 'platform-myob-client-id',
    'integrations.myob.clientSecret': 'platform-myob-client-secret',
    'integrations.myob.redirectUri': 'https://localhost:3000/myob/callback',
  };
  const config = { get: (key: string) => platformConfig[key] } as never;
  const noAppConfig = {
    get: (key: string) => (key === 'integrations.myob.redirectUri' ? platformConfig[key] : undefined),
  } as never;

  function makeService(opts: { config?: typeof config; savedAppCredentials?: { clientId: string; clientSecret: string } | null } = {}) {
    const http = { post: jest.fn() };
    const integrations = {
      connectWithOAuth: jest.fn().mockResolvedValue({ connected: true }),
      disconnect: jest.fn().mockResolvedValue(undefined),
      resolveOAuthAppCredentials: jest.fn().mockResolvedValue(opts.savedAppCredentials ?? null),
      resolveAuth: jest.fn(),
      saveSecondaryCredentials: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MyobService(opts.config ?? config, http as never, jwt, integrations as never);
    return { service, http, integrations };
  }

  it('buildAuthorizeUrl hits the authorize endpoint with read-focused scopes and prompt=consent', async () => {
    const { service } = makeService();
    const url = new URL(await service.buildAuthorizeUrl('org-1'));
    expect(url.origin + url.pathname).toBe('https://secure.myob.com/oauth2/account/authorize');
    expect(url.searchParams.get('client_id')).toBe('platform-myob-client-id');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toContain('sme-sales');
    expect(url.searchParams.get('scope')).not.toContain('sme-payroll');
    const state = jwt.verify<{ organizationId: string; purpose: string }>(url.searchParams.get('state')!);
    expect(state).toMatchObject({ organizationId: 'org-1', purpose: 'myob-oauth' });
  });

  it('throws a clear error when no app credentials are configured anywhere', async () => {
    const { service } = makeService({ config: noAppConfig });
    await expect(service.buildAuthorizeUrl('org-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'MYOB_APP_CREDENTIALS_REQUIRED' }),
    });
    expect(await service.isAppConfigured()).toBe(false);
  });

  it('handleCallback rejects a state signed for a different purpose', async () => {
    const { service, integrations } = makeService();
    const wrongState = jwt.sign({ organizationId: 'org-1', purpose: 'xero-oauth' });
    await expect(service.handleCallback('code', 'business-1', wrongState)).rejects.toThrow(UnauthorizedException);
    expect(integrations.connectWithOAuth).not.toHaveBeenCalled();
  });

  it('handleCallback rejects a missing businessId before ever exchanging the code', async () => {
    const { service, http, integrations } = makeService();
    const state = jwt.sign({ organizationId: 'org-1', purpose: 'myob-oauth' });
    await expect(service.handleCallback('code', '', state)).rejects.toThrow(BadRequestException);
    expect(http.post).not.toHaveBeenCalled();
    expect(integrations.connectWithOAuth).not.toHaveBeenCalled();
  });

  it('on success: exchanges the code, bakes businessId straight into baseUrl, and stores the client id for later header use — no separate discovery call', async () => {
    const { service, http, integrations } = makeService();
    http.post.mockReturnValue(of({ data: { access_token: 'at', refresh_token: 'rt', expires_in: 1200 } }));

    const state = jwt.sign({ organizationId: 'org-1', purpose: 'myob-oauth' });
    await service.handleCallback('auth-code', 'business-abc-123', state);

    const [url, body] = http.post.mock.calls[0];
    expect(url).toBe('https://secure.myob.com/oauth2/v1/authorize');
    expect(String(body)).toContain('grant_type=authorization_code');
    expect(integrations.connectWithOAuth).toHaveBeenCalledWith(
      'org-1',
      'myob',
      expect.objectContaining({
        accessToken: 'at',
        refreshToken: 'rt',
        baseUrl: 'https://api.myob.com/accountright/business-abc-123',
        oauthMeta: { myobClientId: 'platform-myob-client-id' },
      }),
      { skipSync: true },
    );
  });

  it('rejects when MYOB never returns a refresh token', async () => {
    const { service, http, integrations } = makeService();
    http.post.mockReturnValue(of({ data: { access_token: 'at' } }));
    const state = jwt.sign({ organizationId: 'org-1', purpose: 'myob-oauth' });
    await expect(service.handleCallback('auth-code', 'business-1', state)).rejects.toThrow();
    expect(integrations.connectWithOAuth).not.toHaveBeenCalled();
  });

  describe('company-file credentials (the second credential pair MYOB alone needs)', () => {
    it('saveCompanyFileCredentials requires an existing OAuth connection first', async () => {
      const { service, integrations } = makeService();
      integrations.resolveAuth.mockResolvedValue(null);
      await expect(service.saveCompanyFileCredentials('org-1', 'cf-user', 'cf-pass')).rejects.toThrow(BadRequestException);
      expect(integrations.saveSecondaryCredentials).not.toHaveBeenCalled();
    });

    it('saveCompanyFileCredentials persists via IntegrationsService once connected', async () => {
      const { service, integrations } = makeService();
      integrations.resolveAuth.mockResolvedValue({ credentials: { accessToken: 'at' } });
      await service.saveCompanyFileCredentials('org-1', 'cf-user', 'cf-pass');
      expect(integrations.saveSecondaryCredentials).toHaveBeenCalledWith('org-1', 'myob', { username: 'cf-user', password: 'cf-pass' });
    });
  });

  describe('getStatus', () => {
    it('reports not connected when nothing is on file', async () => {
      const { service, integrations } = makeService();
      integrations.resolveAuth.mockResolvedValue(null);
      expect(await service.getStatus('org-1')).toEqual({ connected: false, needsCompanyFileCredentials: false });
    });

    it('reports connected but needing company-file credentials until the second pair is saved', async () => {
      const { service, integrations } = makeService();
      integrations.resolveAuth.mockResolvedValue({ credentials: { accessToken: 'at' }, secondaryCredentials: undefined });
      expect(await service.getStatus('org-1')).toEqual({ connected: true, needsCompanyFileCredentials: true });
    });

    it('reports fully connected once both the OAuth token and company-file credentials are on file', async () => {
      const { service, integrations } = makeService();
      integrations.resolveAuth.mockResolvedValue({ credentials: { accessToken: 'at' }, secondaryCredentials: { username: 'u', password: 'p' } });
      expect(await service.getStatus('org-1')).toEqual({ connected: true, needsCompanyFileCredentials: false });
    });
  });
});
