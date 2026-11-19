import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { SquareService } from './square.service';

// Pure unit tests against hand-rolled mocks of ConfigService/HttpService/
// JwtService/IntegrationsService — no real network calls, no real Mongo.
// Same technique as provider-finance/adapters/anthropic-finance-adapter.
// spec.ts. Covers both connect paths the approved plan ships: the Personal
// Access Token path (connect()) and the per-organization OAuth path
// (buildAuthorizeUrl/handleCallback/saveAppCredentials), plus payment-
// creation idempotency/error mapping.
describe('SquareService', () => {
  function build(overrides: { get?: jest.Mock; post?: jest.Mock; sign?: jest.Mock; verify?: jest.Mock; integrations?: Record<string, jest.Mock>; latestSync?: Record<string, unknown> | null } = {}) {
    const config = { get: (key: string) => (key === 'integrations.square.redirectUri' ? 'https://haive.test/square/callback' : undefined) };
    const http = { get: overrides.get ?? jest.fn(), post: overrides.post ?? jest.fn() };
    const jwt = { sign: overrides.sign ?? jest.fn().mockReturnValue('signed-state'), verify: overrides.verify ?? jest.fn() };
    const integrations = {
      connectWithOAuth: jest.fn().mockResolvedValue(undefined),
      resolveAuth: jest.fn(),
      disconnect: jest.fn().mockResolvedValue(undefined),
      resolveOAuthAppCredentials: jest.fn().mockResolvedValue(null),
      saveOAuthAppCredentials: jest.fn().mockResolvedValue(undefined),
      getOAuthAppCredentialsStatus: jest.fn().mockResolvedValue({ configured: false }),
      ...overrides.integrations,
    };
    const lean = jest.fn().mockResolvedValue(overrides.latestSync ?? null);
    const select = jest.fn().mockReturnValue({ lean });
    const sort = jest.fn().mockReturnValue({ select });
    const transactionModel = { findOne: jest.fn().mockReturnValue({ sort }) };
    const service = new SquareService(config as never, http as never, jwt as never, integrations as never, transactionModel as never);
    return { service, http, jwt, integrations, transactionModel };
  }

  function merchantResponse(country: string) {
    return of({ data: { merchant: { id: 'M1', business_name: 'Acme Co', country, currency: country === 'JP' ? 'JPY' : 'USD' } } });
  }

  describe('connect', () => {
    it('validates the token against Square\'s own Merchants API (GET /v2/merchants/me) before storing anything', async () => {
      const get = jest.fn().mockReturnValue(merchantResponse('US'));
      const { service, integrations } = build({ get });

      const result = await service.connect('org-1', 'app-id-123', 'EAAAEsandboxtoken', 'sandbox');

      expect(get).toHaveBeenCalledWith('https://connect.squareupsandbox.com/v2/merchants/me', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer EAAAEsandboxtoken' }) }));
      expect(result).toMatchObject({ connected: true, applicationId: 'app-id-123', merchantId: 'M1', businessName: 'Acme Co', country: 'US', countrySupported: true });
      expect(integrations.connectWithOAuth).toHaveBeenCalledWith(
        'org-1',
        'square',
        expect.objectContaining({ accessToken: 'EAAAEsandboxtoken', oauthMeta: expect.objectContaining({ merchantId: 'M1', environment: 'sandbox', countrySupported: 'true' }) }),
        { skipSync: true },
      );
    });

    it('calls the production host when environment is production', async () => {
      const get = jest.fn().mockReturnValue(merchantResponse('US'));
      const { service } = build({ get });

      await service.connect('org-1', 'app-id-123', 'prod-token', 'production');

      expect(get).toHaveBeenCalledWith('https://connect.squareup.com/v2/merchants/me', expect.anything());
    });

    it('still connects but honestly flags an unsupported seller country (e.g. India) rather than silently allowing it through', async () => {
      const get = jest.fn().mockReturnValue(merchantResponse('IN'));
      const { service, integrations } = build({ get });

      const result = await service.connect('org-1', 'app-id-123', 'token', 'sandbox');

      expect(result.countrySupported).toBe(false);
      expect(result.country).toBe('IN');
      expect(integrations.connectWithOAuth).toHaveBeenCalledWith(
        'org-1',
        'square',
        expect.objectContaining({ oauthMeta: expect.objectContaining({ country: 'IN', countrySupported: 'false' }) }),
        { skipSync: true },
      );
    });

    it('treats every one of the 8 confirmed-supported seller countries as supported', async () => {
      for (const country of ['US', 'CA', 'GB', 'AU', 'JP', 'IE', 'FR', 'ES']) {
        const get = jest.fn().mockReturnValue(merchantResponse(country));
        const { service } = build({ get });
        const result = await service.connect('org-1', 'app-id-123', 'token', 'sandbox');
        expect(result.countrySupported).toBe(true);
      }
    });

    it('rejects a bad/wrong-environment token with a specific, friendly error instead of a raw 401', async () => {
      const get = jest.fn().mockReturnValue(throwError(() => ({ response: { status: 401 } })));
      const { service, integrations } = build({ get });

      await expect(service.connect('org-1', 'app-id-123', 'wrong-token', 'sandbox')).rejects.toThrow(BadRequestException);
      expect(integrations.connectWithOAuth).not.toHaveBeenCalled();
    });

    it('surfaces Square\'s own error detail when the merchant lookup is rejected for a reason other than a bad token', async () => {
      const get = jest.fn().mockReturnValue(throwError(() => ({ response: { status: 403, data: { errors: [{ detail: 'This application is not authorized.' }] } } })));
      const { service } = build({ get });

      await expect(service.connect('org-1', 'app-id-123', 'token', 'sandbox')).rejects.toThrow('This application is not authorized.');
    });
  });

  describe('testConnection', () => {
    it('reports success with a location count, without saving anything', async () => {
      const get = jest.fn().mockReturnValue(of({ data: { locations: [{ id: 'L1', name: 'Main', status: 'ACTIVE' }] } }));
      const { service, integrations } = build({ get });

      const result = await service.testConnection('a-real-token', 'sandbox');

      expect(result).toEqual({ ok: true, message: 'Connected — found 1 location.' });
      expect(get).toHaveBeenCalledWith('https://connect.squareupsandbox.com/v2/locations', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer a-real-token' }) }));
      expect(integrations.connectWithOAuth).not.toHaveBeenCalled();
    });

    it('reports success but flags zero locations honestly, distinct from a failure', async () => {
      const get = jest.fn().mockReturnValue(of({ data: { locations: [] } }));
      const { service } = build({ get });

      const result = await service.testConnection('a-real-token', 'sandbox');

      expect(result).toEqual({ ok: true, message: 'Connected, but this account has no locations yet.' });
    });

    it('reports a specific failure for a rejected (401) token, never throwing', async () => {
      const get = jest.fn().mockReturnValue(throwError(() => ({ response: { status: 401 } })));
      const { service } = build({ get });

      const result = await service.testConnection('bad-token', 'production');

      expect(result.ok).toBe(false);
      expect(result.message).toContain('401');
      expect(result.message).toContain('production');
    });

    it('surfaces Square\'s own error detail for a non-401 failure', async () => {
      const get = jest.fn().mockReturnValue(throwError(() => ({ response: { status: 403, data: { errors: [{ detail: 'Not authorized for this scope.' }] } } })));
      const { service } = build({ get });

      const result = await service.testConnection('token', 'sandbox');

      expect(result).toEqual({ ok: false, message: 'Not authorized for this scope.' });
    });
  });

  describe('per-organization OAuth path (a different merchant account, not the org\'s own)', () => {
    it('saveAppCredentials stores this organization\'s own Square app, scoped per-org not platform-wide', async () => {
      const integrations = { saveOAuthAppCredentials: jest.fn().mockResolvedValue(undefined) };
      const { service } = build({ integrations });

      await service.saveAppCredentials('org-1', 'app-id-123', 'app-secret-456');

      expect(integrations.saveOAuthAppCredentials).toHaveBeenCalledWith('org-1', 'square', { clientId: 'app-id-123', clientSecret: 'app-secret-456' });
    });

    it('buildAuthorizeUrl refuses when this organization has not saved its own app yet', async () => {
      const { service } = build();
      await expect(service.buildAuthorizeUrl('org-1', 'sandbox')).rejects.toThrow(BadRequestException);
    });

    it('buildAuthorizeUrl builds a sandbox URL with the Phase A scopes, a signed state carrying the environment, and this org\'s own client id', async () => {
      const sign = jest.fn().mockReturnValue('signed-state');
      const integrations = { resolveOAuthAppCredentials: jest.fn().mockResolvedValue({ clientId: 'org-own-client-id', clientSecret: 'org-own-secret' }) };
      const { service } = build({ sign, integrations });

      const url = await service.buildAuthorizeUrl('org-1', 'sandbox');

      expect(url).toContain('https://connect.squareupsandbox.com/oauth2/authorize?');
      expect(url).toContain('client_id=org-own-client-id');
      expect(url).not.toContain('REFUNDS');
      expect(url).not.toContain('CUSTOMERS');
      expect(sign).toHaveBeenCalledWith({ organizationId: 'org-1', purpose: 'square-oauth', environment: 'sandbox' }, { expiresIn: '10m' });
    });

    it('buildAuthorizeUrl builds a production URL when asked for production', async () => {
      const integrations = { resolveOAuthAppCredentials: jest.fn().mockResolvedValue({ clientId: 'org-own-client-id', clientSecret: 'org-own-secret' }) };
      const { service } = build({ integrations });

      const url = await service.buildAuthorizeUrl('org-1', 'production');

      expect(url).toContain('https://connect.squareup.com/oauth2/authorize?');
    });

    it('handleCallback rejects a state with the wrong purpose', async () => {
      const verify = jest.fn().mockReturnValue({ organizationId: 'org-1', purpose: 'zoho-oauth' });
      const { service } = build({ verify });
      await expect(service.handleCallback('code', 'state')).rejects.toThrow(UnauthorizedException);
    });

    it('handleCallback rejects an expired/invalid state', async () => {
      const verify = jest.fn().mockImplementation(() => {
        throw new Error('jwt expired');
      });
      const { service } = build({ verify });
      await expect(service.handleCallback('code', 'bad-state')).rejects.toThrow(UnauthorizedException);
    });

    it('handleCallback exchanges the code, fetches the merchant, and connects with a REAL refresh token (unlike the Personal Access Token path)', async () => {
      const post = jest.fn().mockReturnValue(of({ data: { access_token: 'sq-at', refresh_token: 'sq-rt', merchant_id: 'M1', expires_at: new Date(Date.now() + 2_592_000_000).toISOString() } }));
      const get = jest.fn().mockReturnValue(of({ data: { merchant: { id: 'M1', business_name: 'Acme Co', country: 'US', currency: 'USD' } } }));
      const verify = jest.fn().mockReturnValue({ organizationId: 'org-1', purpose: 'square-oauth', environment: 'sandbox' });
      const integrationsOverride = { resolveOAuthAppCredentials: jest.fn().mockResolvedValue({ clientId: 'org-own-client-id', clientSecret: 'org-own-secret' }) };
      const { service, integrations } = build({ post, get, verify, integrations: integrationsOverride });

      const result = await service.handleCallback('auth-code', 'good-state');

      expect(result).toMatchObject({ connected: true, merchantId: 'M1', countrySupported: true, organizationId: 'org-1' });
      expect(integrations.connectWithOAuth).toHaveBeenCalledWith(
        'org-1',
        'square',
        expect.objectContaining({ accessToken: 'sq-at', refreshToken: 'sq-rt' }),
        { skipSync: true },
      );
      const [url, body] = post.mock.calls[0];
      expect(url).toBe('https://connect.squareupsandbox.com/oauth2/token');
      expect(body).toMatchObject({ grant_type: 'authorization_code', code: 'auth-code', client_id: 'org-own-client-id' });
    });

    it('handleCallback still connects but honestly flags an unsupported seller country via the OAuth path too', async () => {
      const post = jest.fn().mockReturnValue(of({ data: { access_token: 'sq-at', refresh_token: 'sq-rt', expires_at: new Date(Date.now() + 1000).toISOString() } }));
      const get = jest.fn().mockReturnValue(of({ data: { merchant: { id: 'M1', country: 'IN', currency: 'INR' } } }));
      const verify = jest.fn().mockReturnValue({ organizationId: 'org-1', purpose: 'square-oauth', environment: 'sandbox' });
      const integrations = { resolveOAuthAppCredentials: jest.fn().mockResolvedValue({ clientId: 'id', clientSecret: 'secret' }) };
      const { service } = build({ post, get, verify, integrations });

      const result = await service.handleCallback('auth-code', 'good-state');

      expect(result.countrySupported).toBe(false);
      expect(result.country).toBe('IN');
    });
  });

  describe('createPayment', () => {
    function withAuth(overrides: Record<string, unknown> = {}) {
      return {
        integrationId: 'id',
        authType: 'oauth2' as const,
        credentials: { accessToken: 'sq-at' },
        oauthMeta: { environment: 'sandbox', merchantId: 'M1', ...overrides },
      };
    }

    it('generates an idempotency key when the caller omits one — never silently reusing a predictable value', async () => {
      const post = jest.fn().mockReturnValue(of({ data: { payment: { id: 'pay_1', status: 'COMPLETED' } } }));
      const integrations = { resolveAuth: jest.fn().mockResolvedValue(withAuth()) };
      const { service } = build({ post, integrations });

      await service.createPayment('org-1', { sourceId: 'cnon:card-nonce', amount: 1000, currency: 'USD' });

      const [, body] = post.mock.calls[0];
      expect(typeof body.idempotency_key).toBe('string');
      expect(body.idempotency_key.length).toBeGreaterThan(10);
    });

    it('uses the caller-supplied idempotency key verbatim when given one', async () => {
      const post = jest.fn().mockReturnValue(of({ data: { payment: { id: 'pay_2', status: 'COMPLETED' } } }));
      const integrations = { resolveAuth: jest.fn().mockResolvedValue(withAuth()) };
      const { service } = build({ post, integrations });

      await service.createPayment('org-1', { sourceId: 'cnon:card-nonce', amount: 500, currency: 'USD', idempotencyKey: 'my-fixed-key' });

      const [, body] = post.mock.calls[0];
      expect(body.idempotency_key).toBe('my-fixed-key');
      expect(body.amount_money).toEqual({ amount: 500, currency: 'USD' });
    });

    it('surfaces Square\'s own error detail on rejection, rather than a generic failure', async () => {
      const post = jest.fn().mockReturnValue(of({ data: { errors: [{ detail: 'Card declined.' }] } }));
      const integrations = { resolveAuth: jest.fn().mockResolvedValue(withAuth()) };
      const { service } = build({ post, integrations });

      await expect(service.createPayment('org-1', { sourceId: 'cnon:bad', amount: 100, currency: 'USD' })).rejects.toThrow('Card declined.');
    });

    it('refuses to create a payment when Square isn\'t connected for the organization', async () => {
      const integrations = { resolveAuth: jest.fn().mockResolvedValue(null) };
      const { service } = build({ integrations });

      await expect(service.createPayment('org-1', { sourceId: 'cnon:x', amount: 100, currency: 'USD' })).rejects.toThrow(BadRequestException);
    });
  });

  describe('getStatus', () => {
    it('reports disconnected when no Square auth exists for the organization', async () => {
      const integrations = { resolveAuth: jest.fn().mockResolvedValue(null) };
      const { service } = build({ integrations });
      expect(await service.getStatus('org-1')).toEqual({ connected: false });
    });

    it('surfaces the stored country/currency/environment without re-fetching the merchant', async () => {
      const integrations = {
        resolveAuth: jest.fn().mockResolvedValue({
          integrationId: 'id',
          authType: 'oauth2',
          credentials: { accessToken: 'sq-at' },
          oauthMeta: { environment: 'production', merchantId: 'M1', businessName: 'Acme', country: 'US', currency: 'USD', countrySupported: 'true' },
        }),
      };
      const { service, http } = build({ integrations });

      const status = await service.getStatus('org-1');

      expect(status).toMatchObject({ connected: true, environment: 'production', country: 'US', countrySupported: true });
      expect(http.get).not.toHaveBeenCalled();
    });

    it('a Personal Access Token connection (applicationId present) reports connectionType personal_access_token and never checks for a webhook secret — Square webhooks are app-level and this path has no app', async () => {
      const integrations = {
        resolveAuth: jest.fn().mockResolvedValue({ credentials: { accessToken: 'sq-at' }, oauthMeta: { environment: 'sandbox', applicationId: 'app-123' } }),
        getOAuthAppCredentialsStatus: jest.fn(),
      };
      const { service } = build({ integrations });

      const status = await service.getStatus('org-1');

      expect(status.connectionType).toBe('personal_access_token');
      expect(integrations.getOAuthAppCredentialsStatus).not.toHaveBeenCalled();
    });

    it('an OAuth connection (no applicationId) reports connectionType oauth and surfaces whether a webhook secret is on file', async () => {
      const integrations = {
        resolveAuth: jest.fn().mockResolvedValue({ credentials: { accessToken: 'sq-at' }, oauthMeta: { environment: 'sandbox', merchantId: 'M1' } }),
        getOAuthAppCredentialsStatus: jest.fn().mockResolvedValue({ configured: true, webhookSecretConfigured: true }),
      };
      const { service } = build({ integrations });

      const status = await service.getStatus('org-1');

      expect(status.connectionType).toBe('oauth');
      expect(status.webhookConfigured).toBe(true);
    });

    it('surfaces the most recent square_payment_transactions sync time for this organization, or undefined when nothing has synced yet', async () => {
      const integrations = { resolveAuth: jest.fn().mockResolvedValue({ credentials: { accessToken: 'sq-at' }, oauthMeta: { environment: 'sandbox', applicationId: 'app-123' } }) };
      const lastSyncedAt = new Date('2026-11-18T09:00:00Z');
      const { service: synced } = build({ integrations, latestSync: { lastSyncedAt } });
      const { service: neverSynced } = build({ integrations, latestSync: null });

      expect((await synced.getStatus('org-1')).lastPaymentSyncAt).toEqual(lastSyncedAt);
      expect((await neverSynced.getStatus('org-1')).lastPaymentSyncAt).toBeUndefined();
    });
  });
});
