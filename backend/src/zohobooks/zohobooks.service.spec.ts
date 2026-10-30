import { JwtService } from '@nestjs/jwt';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { of } from 'rxjs';
import { ZohoBooksService } from './zohobooks.service';

// Same split as zoho.service.spec.ts/xero.service.spec.ts: unit-level,
// IntegrationsService mocked (real persistence is covered against a real
// Mongo in integrations/integrations-oauth.spec.ts). Specifically proves
// Zoho Books resolves its OWN app credentials (never Zoho CRM's, even
// though both are "Zoho" and share the same data-center list/DTO) and
// handles the single-vs-multi "Books organization" selection correctly.
describe('ZohoBooksService', () => {
  const jwt = new JwtService({ secret: 'test-secret' });
  const platformConfig: Record<string, string> = {
    'integrations.zohobooks.clientId': 'platform-books-client-id',
    'integrations.zohobooks.clientSecret': 'platform-books-client-secret',
    'integrations.zohobooks.redirectUri': 'http://localhost:3000/zohobooks/callback',
    'integrations.zohobooks.accountsBaseUrl': 'https://accounts.zoho.com',
  };
  const config = { get: (key: string) => platformConfig[key] } as never;
  const noAppConfig = {
    get: (key: string) => (key === 'integrations.zohobooks.redirectUri' ? platformConfig[key] : undefined),
  } as never;

  function makeService(
    opts: { config?: typeof config; orgAppCredentials?: { clientId: string; clientSecret: string; meta?: Record<string, string> } | null } = {},
  ) {
    const http = { post: jest.fn(), get: jest.fn() };
    const integrations = {
      connectWithOAuth: jest.fn().mockResolvedValue({ connected: true }),
      disconnect: jest.fn().mockResolvedValue(undefined),
      saveOAuthAppCredentials: jest.fn().mockResolvedValue(undefined),
      getOAuthAppCredentialsStatus: jest.fn(),
      resolveOAuthAppCredentials: jest.fn().mockResolvedValue(opts.orgAppCredentials ?? null),
      resolveAuth: jest.fn(),
      mergeOAuthMeta: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ZohoBooksService(opts.config ?? config, http as never, jwt, integrations as never);
    return { service, http, integrations };
  }

  describe('app-credential precedence — independent of Zoho CRM', () => {
    it('buildAuthorizeUrl uses the platform app when the organization has not configured its own Books app', async () => {
      const { service, integrations } = makeService();
      const url = new URL(await service.buildAuthorizeUrl('org-1'));
      expect(url.searchParams.get('client_id')).toBe('platform-books-client-id');
      // Resolved under provider 'zohobooks' specifically, never 'zoho'.
      expect(integrations.resolveOAuthAppCredentials).toHaveBeenCalledWith('org-1', 'zohobooks');
    });

    it('buildAuthorizeUrl prefers the organization\'s own saved Books app over the platform app', async () => {
      const { service } = makeService({
        orgAppCredentials: { clientId: 'org-books-client-id', clientSecret: 'org-books-secret', meta: { accountsServer: 'https://accounts.zoho.in' } },
      });
      const url = new URL(await service.buildAuthorizeUrl('org-1'));
      expect(url.searchParams.get('client_id')).toBe('org-books-client-id');
      expect(url.origin + url.pathname).toBe('https://accounts.zoho.in/oauth/v2/auth');
    });

    it('throws a clear, user-facing error when neither the org nor the platform has Books credentials configured', async () => {
      const { service } = makeService({ config: noAppConfig });
      await expect(service.buildAuthorizeUrl('org-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'ZOHOBOOKS_APP_CREDENTIALS_REQUIRED' }),
      });
    });
  });

  it('buildAuthorizeUrl requests only a read-only Books scope', async () => {
    const { service } = makeService();
    const url = new URL(await service.buildAuthorizeUrl('org-1'));
    expect(url.searchParams.get('scope')).toBe('ZohoBooks.fullaccess.READ');
    const state = jwt.verify<{ organizationId: string; purpose: string }>(url.searchParams.get('state')!);
    expect(state).toMatchObject({ organizationId: 'org-1', purpose: 'zohobooks-oauth' });
  });

  it('handleCallback rejects a state signed for the wrong purpose (e.g. a reused Zoho CRM state)', async () => {
    const { service, integrations } = makeService();
    const wrongPurposeState = jwt.sign({ organizationId: 'org-1', purpose: 'zoho-oauth' });
    await expect(service.handleCallback('code', wrongPurposeState)).rejects.toThrow(UnauthorizedException);
    expect(integrations.connectWithOAuth).not.toHaveBeenCalled();
  });

  it('single-organization authorization connects immediately with no selection needed', async () => {
    const { service, http, integrations } = makeService();
    http.post.mockReturnValue(of({ data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, api_domain: 'https://www.zohoapis.com' } }));
    http.get.mockReturnValue(of({ data: { organizations: [{ organization_id: 'books-org-1', name: 'Demo Co Books' }] } }));

    const state = jwt.sign({ organizationId: 'org-1', purpose: 'zohobooks-oauth' });
    const result = await service.handleCallback('auth-code', state);

    expect(result.needsSelection).toBe(false);
    expect(integrations.connectWithOAuth).toHaveBeenCalledWith(
      'org-1',
      'zohobooks',
      expect.objectContaining({
        accessToken: 'at',
        refreshToken: 'rt',
        oauthMeta: expect.objectContaining({ booksApiDomain: 'https://www.zohoapis.com', booksOrganizationId: 'books-org-1', booksOrganizationName: 'Demo Co Books' }),
      }),
      { skipSync: true },
    );
  });

  it('multi-organization authorization connects but defers selection', async () => {
    const { service, http, integrations } = makeService();
    http.post.mockReturnValue(of({ data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, api_domain: 'https://www.zohoapis.com' } }));
    http.get.mockReturnValue(
      of({
        data: {
          organizations: [
            { organization_id: 'books-org-1', name: 'Demo Co Books' },
            { organization_id: 'books-org-2', name: 'Second Co Books' },
          ],
        },
      }),
    );

    const state = jwt.sign({ organizationId: 'org-1', purpose: 'zohobooks-oauth' });
    const result = await service.handleCallback('auth-code', state);

    expect(result.needsSelection).toBe(true);
    expect(result.orgs).toHaveLength(2);
    const call = integrations.connectWithOAuth.mock.calls[0];
    expect(call[2].oauthMeta.booksOrganizationId).toBeUndefined();
  });

  it('listOrganizations call uses the Zoho-oauthtoken scheme, not Bearer', async () => {
    const { service, http } = makeService();
    http.post.mockReturnValue(of({ data: { access_token: 'at-xyz', refresh_token: 'rt', expires_in: 3600, api_domain: 'https://www.zohoapis.com' } }));
    http.get.mockReturnValue(of({ data: { organizations: [{ organization_id: 'o1', name: 'Co' }] } }));

    const state = jwt.sign({ organizationId: 'org-1', purpose: 'zohobooks-oauth' });
    await service.handleCallback('auth-code', state);

    const [url, options] = http.get.mock.calls[0];
    expect(url).toBe('https://www.zohoapis.com/books/v3/organizations');
    expect(options.headers.Authorization).toBe('Zoho-oauthtoken at-xyz');
  });

  describe('selectOrganization', () => {
    it('merges the chosen organization into oauthMeta', async () => {
      const { service, integrations } = makeService();
      integrations.resolveAuth.mockResolvedValue({
        oauthMeta: { organizations: JSON.stringify([{ organizationId: 'o-1', name: 'Co A' }, { organizationId: 'o-2', name: 'Co B' }]) },
      });
      await service.selectOrganization('org-1', 'o-2');
      expect(integrations.mergeOAuthMeta).toHaveBeenCalledWith('org-1', 'zohobooks', { booksOrganizationId: 'o-2', booksOrganizationName: 'Co B' });
    });

    it('rejects an organization id that was never part of the original authorization', async () => {
      const { service, integrations } = makeService();
      integrations.resolveAuth.mockResolvedValue({ oauthMeta: { organizations: JSON.stringify([{ organizationId: 'o-1', name: 'Co A' }]) } });
      await expect(service.selectOrganization('org-1', 'not-real')).rejects.toThrow(BadRequestException);
    });
  });

  it('rolls back implicitly (never persists) when Zoho Books reports zero organizations', async () => {
    const { service, http, integrations } = makeService();
    http.post.mockReturnValue(of({ data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, api_domain: 'https://www.zohoapis.com' } }));
    http.get.mockReturnValue(of({ data: { organizations: [] } }));

    const state = jwt.sign({ organizationId: 'org-1', purpose: 'zohobooks-oauth' });
    await expect(service.handleCallback('auth-code', state)).rejects.toThrow(BadRequestException);
    expect(integrations.connectWithOAuth).not.toHaveBeenCalled();
  });
});
