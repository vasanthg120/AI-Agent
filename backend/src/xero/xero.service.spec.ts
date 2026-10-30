import { JwtService } from '@nestjs/jwt';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { of } from 'rxjs';
import { XeroService } from './xero.service';

// Unit-level (no Mongo): same split as zoho.service.spec.ts — real
// persistence (connectWithOAuth/mergeOAuthMeta) is IntegrationsService's own
// job, covered against a real Mongo in integrations/integrations-oauth.spec.ts.
// This is specifically the OAuth mechanics XeroService itself owns: platform
// app-credential resolution, state signing/verification, the single-vs-
// multi-tenant callback branch, and tenant selection.
describe('XeroService', () => {
  const jwt = new JwtService({ secret: 'test-secret' });
  const platformConfig: Record<string, string> = {
    'integrations.xero.clientId': 'platform-client-id',
    'integrations.xero.clientSecret': 'platform-client-secret',
    'integrations.xero.redirectUri': 'http://localhost:3000/xero/callback',
  };
  const config = { get: (key: string) => platformConfig[key] } as never;
  const noAppConfig = {
    get: (key: string) => (key === 'integrations.xero.redirectUri' ? platformConfig[key] : undefined),
  } as never;

  function makeService(opts: { config?: typeof config; savedAppCredentials?: { clientId: string; clientSecret: string } | null } = {}) {
    const http = { post: jest.fn(), get: jest.fn() };
    const integrations = {
      connectWithOAuth: jest.fn().mockResolvedValue({ connected: true }),
      disconnect: jest.fn().mockResolvedValue(undefined),
      resolveOAuthAppCredentials: jest.fn().mockResolvedValue(opts.savedAppCredentials ?? null),
      resolveAuth: jest.fn(),
      mergeOAuthMeta: jest.fn().mockResolvedValue(undefined),
    };
    const service = new XeroService(opts.config ?? config, http as never, jwt, integrations as never);
    return { service, http, integrations };
  }

  describe('app-credential precedence (platform-wide, same as Gmail)', () => {
    it('buildAuthorizeUrl uses the platform env-var app when nothing is saved in the DB', async () => {
      const { service, integrations } = makeService();
      const url = new URL(await service.buildAuthorizeUrl('org-1'));
      expect(url.searchParams.get('client_id')).toBe('platform-client-id');
      expect(integrations.resolveOAuthAppCredentials).toHaveBeenCalledWith('platform', 'xero');
    });

    it('buildAuthorizeUrl prefers a DB-saved platform app over the env var fallback', async () => {
      const { service } = makeService({ savedAppCredentials: { clientId: 'saved-client-id', clientSecret: 'saved-secret' } });
      const url = new URL(await service.buildAuthorizeUrl('org-1'));
      expect(url.searchParams.get('client_id')).toBe('saved-client-id');
    });

    it('throws a clear, user-facing error when neither the DB nor env vars have credentials', async () => {
      const { service } = makeService({ config: noAppConfig });
      await expect(service.buildAuthorizeUrl('org-1')).rejects.toThrow(BadRequestException);
      await expect(service.buildAuthorizeUrl('org-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'XERO_APP_CREDENTIALS_REQUIRED' }),
      });
      expect(await service.isAppConfigured()).toBe(false);
    });
  });

  it('buildAuthorizeUrl requests only read-only scopes and signs organizationId into state', async () => {
    const { service } = makeService();
    const url = new URL(await service.buildAuthorizeUrl('org-1'));
    const scope = url.searchParams.get('scope') ?? '';
    expect(scope).toContain('offline_access');
    expect(scope).toContain('accounting.transactions.read');
    expect(scope).not.toContain('.write');
    const state = jwt.verify<{ organizationId: string; purpose: string }>(url.searchParams.get('state')!);
    expect(state).toMatchObject({ organizationId: 'org-1', purpose: 'xero-oauth' });
  });

  it('handleCallback rejects a state signed for a different purpose', async () => {
    const { service, integrations } = makeService();
    const wrongPurposeState = jwt.sign({ organizationId: 'org-1', purpose: 'zoho-oauth' });
    await expect(service.handleCallback('code', wrongPurposeState)).rejects.toThrow(UnauthorizedException);
    expect(integrations.connectWithOAuth).not.toHaveBeenCalled();
  });

  it('handleCallback rejects a garbage/expired state before ever exchanging the code', async () => {
    const { service, http } = makeService();
    await expect(service.handleCallback('code', 'not-a-real-jwt')).rejects.toThrow(UnauthorizedException);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('single-tenant authorization connects immediately with no selection needed', async () => {
    const { service, http, integrations } = makeService();
    http.post.mockReturnValue(of({ data: { access_token: 'at', refresh_token: 'rt', expires_in: 1800 } }));
    http.get.mockReturnValue(of({ data: [{ tenantId: 'tenant-1', tenantName: 'Demo Co', tenantType: 'ORGANISATION' }] }));

    const state = jwt.sign({ organizationId: 'org-1', purpose: 'xero-oauth' });
    const result = await service.handleCallback('auth-code', state);

    expect(result.needsSelection).toBe(false);
    expect(integrations.connectWithOAuth).toHaveBeenCalledWith(
      'org-1',
      'xero',
      expect.objectContaining({
        accessToken: 'at',
        refreshToken: 'rt',
        baseUrl: 'https://api.xero.com/api.xro/2.0',
        oauthMeta: expect.objectContaining({ tenantId: 'tenant-1', tenantName: 'Demo Co' }),
      }),
      { skipSync: true },
    );
  });

  it('multi-tenant authorization connects but defers tenant selection, exposing every option', async () => {
    const { service, http, integrations } = makeService();
    http.post.mockReturnValue(of({ data: { access_token: 'at', refresh_token: 'rt', expires_in: 1800 } }));
    http.get.mockReturnValue(
      of({
        data: [
          { tenantId: 'tenant-1', tenantName: 'Demo Co', tenantType: 'ORGANISATION' },
          { tenantId: 'tenant-2', tenantName: 'Second Co', tenantType: 'ORGANISATION' },
        ],
      }),
    );

    const state = jwt.sign({ organizationId: 'org-1', purpose: 'xero-oauth' });
    const result = await service.handleCallback('auth-code', state);

    expect(result.needsSelection).toBe(true);
    expect(result.tenants).toEqual([
      { tenantId: 'tenant-1', tenantName: 'Demo Co' },
      { tenantId: 'tenant-2', tenantName: 'Second Co' },
    ]);
    const call = integrations.connectWithOAuth.mock.calls[0];
    // Connected (so refresh/disconnect already work) but no tenantId chosen yet.
    expect(call[2].oauthMeta.tenantId).toBeUndefined();
    expect(JSON.parse(call[2].oauthMeta.tenants)).toHaveLength(2);
  });

  it('handleCallback throws if Xero reports zero authorized organisations', async () => {
    const { service, http, integrations } = makeService();
    http.post.mockReturnValue(of({ data: { access_token: 'at', refresh_token: 'rt', expires_in: 1800 } }));
    http.get.mockReturnValue(of({ data: [] }));

    const state = jwt.sign({ organizationId: 'org-1', purpose: 'xero-oauth' });
    await expect(service.handleCallback('auth-code', state)).rejects.toThrow(BadRequestException);
    expect(integrations.connectWithOAuth).not.toHaveBeenCalled();
  });

  describe('selectTenant', () => {
    it('finishes a pending connection by merging the chosen tenant into oauthMeta', async () => {
      const { service, integrations } = makeService();
      integrations.resolveAuth.mockResolvedValue({
        oauthMeta: { tenants: JSON.stringify([{ tenantId: 't-1', tenantName: 'Demo Co' }, { tenantId: 't-2', tenantName: 'Second Co' }]) },
      });
      await service.selectTenant('org-1', 't-2');
      expect(integrations.mergeOAuthMeta).toHaveBeenCalledWith('org-1', 'xero', { tenantId: 't-2', tenantName: 'Second Co' });
    });

    it('rejects a tenantId that was never part of the original authorization', async () => {
      const { service, integrations } = makeService();
      integrations.resolveAuth.mockResolvedValue({ oauthMeta: { tenants: JSON.stringify([{ tenantId: 't-1', tenantName: 'Demo Co' }]) } });
      await expect(service.selectTenant('org-1', 'not-a-real-tenant')).rejects.toThrow(BadRequestException);
      expect(integrations.mergeOAuthMeta).not.toHaveBeenCalled();
    });

    it('rejects selecting a tenant when nothing is connected yet', async () => {
      const { service, integrations } = makeService();
      integrations.resolveAuth.mockResolvedValue(null);
      await expect(service.selectTenant('org-1', 't-1')).rejects.toThrow(BadRequestException);
    });
  });

  it('rejects the code exchange when Xero never returns a refresh token', async () => {
    const { service, http, integrations } = makeService();
    http.post.mockReturnValue(of({ data: { access_token: 'at' } }));

    const state = jwt.sign({ organizationId: 'org-1', purpose: 'xero-oauth' });
    await expect(service.handleCallback('auth-code', state)).rejects.toThrow();
    expect(integrations.connectWithOAuth).not.toHaveBeenCalled();
  });
});
