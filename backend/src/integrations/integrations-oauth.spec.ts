import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { of, throwError } from 'rxjs';
import { EncryptionService } from '../common/encryption/encryption.service';
import { IntegrationsService } from './integrations.service';
import { IntegrationCredential, IntegrationCredentialDocument, IntegrationCredentialSchema } from './schemas/integration-credential.schema';

// Real Mongo + real encryption, HTTP/DataSources mocked — same split
// crm-integrations.spec.ts uses: this is specifically about what actually
// gets persisted and read back for an oauth2 credential (Zoho/Salesforce),
// not about the live provider calls themselves.
const PREFIX = `jest-oauth-${Date.now()}`;

describe('IntegrationsService — oauth2 (Zoho/Salesforce)', () => {
  let connection: Connection;
  let credentialModel: Model<IntegrationCredentialDocument>;
  let service: IntegrationsService;
  const http = { post: jest.fn() };
  const dataSources = { reconcile: jest.fn().mockResolvedValue(undefined) };
  let seq = 0;
  let org: string;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([{ name: IntegrationCredential.name, schema: IntegrationCredentialSchema }]),
      ],
    }).compile();
    credentialModel = moduleRef.get(getModelToken(IntegrationCredential.name));
    connection = moduleRef.get(getConnectionToken());
    await credentialModel.init();

    const encryption = new EncryptionService({ get: () => `${PREFIX}-key-at-least-32-bytes-long!!` } as never);
    const jwt = { sign: () => 'jwt' } as never;
    const config = {
      get: (key: string) => {
        const values: Record<string, string> = {
          pythonAgentUrl: 'http://localhost:8000',
          'integrations.zoho.accountsBaseUrl': 'https://accounts.zoho.com',
          'integrations.zoho.clientId': 'zoho-client-id',
          'integrations.zoho.clientSecret': 'zoho-client-secret',
          'integrations.salesforce.authBaseUrl': 'https://login.salesforce.com',
          'integrations.salesforce.clientId': 'sf-client-id',
          'integrations.salesforce.clientSecret': 'sf-client-secret',
          'integrations.xero.clientId': 'xero-client-id',
          'integrations.xero.clientSecret': 'xero-client-secret',
          'integrations.zohobooks.accountsBaseUrl': 'https://accounts.zoho.com',
          'integrations.zohobooks.clientId': 'zohobooks-client-id',
          'integrations.zohobooks.clientSecret': 'zohobooks-client-secret',
          'integrations.myob.clientId': 'myob-client-id',
          'integrations.myob.clientSecret': 'myob-client-secret',
          'integrations.zohopayroll.accountsBaseUrl': 'https://accounts.zoho.com',
          'integrations.zohopayroll.clientId': 'zohopayroll-client-id',
          'integrations.zohopayroll.clientSecret': 'zohopayroll-client-secret',
        };
        return values[key];
      },
    } as never;
    service = new IntegrationsService(credentialModel, encryption, http as never, jwt, config, dataSources as never);
  });

  beforeEach(() => {
    seq += 1;
    org = `${PREFIX}-org-${seq}`;
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await credentialModel.deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await connection.close();
  });

  it('connectWithOAuth stores the token pair encrypted, with the raw refresh token never readable from the document', async () => {
    await service.connectWithOAuth(
      org,
      'zoho',
      { accessToken: 'at-1', refreshToken: 'rt-1', expiresInSeconds: 3600, oauthMeta: { accountsServer: 'https://accounts.zoho.com', apiDomain: 'https://www.zohoapis.com' } },
      { skipSync: true },
    );
    const doc = await credentialModel.findOne({ organizationId: org, provider: 'zoho' });
    expect(doc?.authType).toBe('oauth2');
    expect(doc?.status).toBe('connected');
    expect(doc?.credentialsEncrypted).not.toContain('at-1');
    expect(doc?.refreshTokenEncrypted).not.toContain('rt-1');
    expect(doc?.oauthMeta).toMatchObject({ apiDomain: 'https://www.zohoapis.com' });
    expect(dataSources.reconcile).toHaveBeenCalledWith(org);

    const resolved = await service.resolveAuth(org, 'zoho');
    expect(resolved?.credentials.accessToken).toBe('at-1');
  });

  it('resolveAuth returns the stored token unchanged when it is not near expiry (no refresh call made)', async () => {
    await service.connectWithOAuth(org, 'zoho', { accessToken: 'at-fresh', refreshToken: 'rt-1', expiresInSeconds: 3600 }, { skipSync: true });
    const resolved = await service.resolveAuth(org, 'zoho');
    expect(resolved?.credentials.accessToken).toBe('at-fresh');
    expect(http.post).not.toHaveBeenCalled();
  });

  it('resolveAuth refreshes a near-expiry Zoho token, persists the new one, and returns it', async () => {
    await service.connectWithOAuth(org, 'zoho', { accessToken: 'at-old', refreshToken: 'rt-1', expiresInSeconds: -10 }, { skipSync: true });
    http.post.mockReturnValueOnce(of({ data: { access_token: 'at-new', expires_in: 3600, api_domain: 'https://www.zohoapis.eu' } }));

    const resolved = await service.resolveAuth(org, 'zoho');
    expect(resolved?.credentials.accessToken).toBe('at-new');
    expect(http.post).toHaveBeenCalledTimes(1);
    const [url, body] = http.post.mock.calls[0];
    expect(url).toBe('https://accounts.zoho.com/oauth/v2/token');
    expect(String(body)).toContain('grant_type=refresh_token');

    const doc = await credentialModel.findOne({ organizationId: org, provider: 'zoho' });
    expect(doc?.oauthMeta?.apiDomain).toBe('https://www.zohoapis.eu');
    expect(doc?.status).toBe('connected');
  });

  it('resolveAuth refreshes a near-expiry Salesforce token using instanceUrl from oauthMeta', async () => {
    await service.connectWithOAuth(
      org,
      'salesforce',
      { accessToken: 'sf-old', refreshToken: 'sf-rt', expiresInSeconds: -10, oauthMeta: { instanceUrl: 'https://my-org.my.salesforce.com' } },
      { skipSync: true },
    );
    http.post.mockReturnValueOnce(of({ data: { access_token: 'sf-new', instance_url: 'https://my-org.my.salesforce.com' } }));

    const resolved = await service.resolveAuth(org, 'salesforce');
    expect(resolved?.credentials.accessToken).toBe('sf-new');
    expect(resolved?.baseUrl).toBe('https://my-org.my.salesforce.com');
  });

  it('marks the connection needs_reauth when the refresh call fails, and resolveAuth then returns no usable token', async () => {
    await service.connectWithOAuth(org, 'zoho', { accessToken: 'at-old', refreshToken: 'rt-dead', expiresInSeconds: -10 }, { skipSync: true });
    http.post.mockReturnValueOnce(throwError(() => new Error('invalid_grant')));

    const resolved = await service.resolveAuth(org, 'zoho');
    expect(resolved?.credentials.accessToken).toBeUndefined();

    const doc = await credentialModel.findOne({ organizationId: org, provider: 'zoho' });
    expect(doc?.status).toBe('needs_reauth');

    // A second call doesn't retry the dead refresh token against the provider again.
    http.post.mockClear();
    await service.resolveAuth(org, 'zoho');
    expect(http.post).not.toHaveBeenCalled();
  });

  it('a non-oauth2 provider (e.g. bearer) is completely unaffected by any of this', async () => {
    await service.connectWithAuth(org, 'hubspot', { authType: 'bearer', credentials: { bearerToken: 'hs-token' } } as never, { skipSync: true });
    const resolved = await service.resolveAuth(org, 'hubspot');
    expect(resolved?.credentials.bearerToken).toBe('hs-token');
    expect(http.post).not.toHaveBeenCalled();
  });

  describe('organization-owned OAuth app credentials (Zoho "bring your own app")', () => {
    it('saveOAuthAppCredentials persists the secret encrypted, never in plaintext', async () => {
      await service.saveOAuthAppCredentials(org, 'zoho', {
        clientId: 'org-client-id',
        clientSecret: 'org-super-secret',
        meta: { accountsServer: 'https://accounts.zoho.in', region: 'in' },
      });
      const doc = await credentialModel.findOne({ organizationId: org, provider: 'zoho' });
      expect(doc?.oauthClientId).toBe('org-client-id');
      expect(doc?.oauthClientSecretEncrypted).toBeDefined();
      expect(doc?.oauthClientSecretEncrypted).not.toContain('org-super-secret');
    });

    it('getOAuthAppCredentialsStatus never returns the real secret, only a fixed mask', async () => {
      await service.saveOAuthAppCredentials(org, 'zoho', { clientId: 'org-client-id', clientSecret: 'org-super-secret' });
      const status = await service.getOAuthAppCredentialsStatus(org, 'zoho');
      expect(status).toEqual({ configured: true, clientId: 'org-client-id', clientSecretMasked: expect.any(String), meta: undefined });
      expect(JSON.stringify(status)).not.toContain('org-super-secret');
    });

    it('getOAuthAppCredentialsStatus reports not configured when nothing was saved', async () => {
      expect(await service.getOAuthAppCredentialsStatus(org, 'zoho')).toEqual({ configured: false });
    });

    it('resolveOAuthAppCredentials (internal use) decrypts the real secret', async () => {
      await service.saveOAuthAppCredentials(org, 'zoho', { clientId: 'org-client-id', clientSecret: 'org-super-secret' });
      const resolved = await service.resolveOAuthAppCredentials(org, 'zoho');
      expect(resolved).toMatchObject({ clientId: 'org-client-id', clientSecret: 'org-super-secret' });
    });

    it('saving app credentials does NOT disconnect or clear an already-connected organization', async () => {
      await service.connectWithOAuth(org, 'zoho', { accessToken: 'at-1', refreshToken: 'rt-1', expiresInSeconds: 3600 }, { skipSync: true });
      await service.saveOAuthAppCredentials(org, 'zoho', { clientId: 'new-client-id', clientSecret: 'new-secret' });

      const doc = await credentialModel.findOne({ organizationId: org, provider: 'zoho' });
      expect(doc?.oauthClientId).toBe('new-client-id');
      // Still connected — the token pair saved before this call is untouched.
      expect(doc?.status).toBe('connected');
      const resolved = await service.resolveAuth(org, 'zoho');
      expect(resolved?.credentials.accessToken).toBe('at-1');
    });

    it('refreshOAuthToken uses the organization\'s own saved app credentials, not the platform\'s, once configured', async () => {
      await service.saveOAuthAppCredentials(org, 'zoho', { clientId: 'org-client-id', clientSecret: 'org-secret', meta: { accountsServer: 'https://accounts.zoho.in' } });
      await service.connectWithOAuth(org, 'zoho', { accessToken: 'at-old', refreshToken: 'rt-1', expiresInSeconds: -10, oauthMeta: { accountsServer: 'https://accounts.zoho.in' } }, { skipSync: true });
      http.post.mockReturnValueOnce(of({ data: { access_token: 'at-new', expires_in: 3600 } }));

      await service.resolveAuth(org, 'zoho');
      const [url, body] = http.post.mock.calls[0];
      expect(url).toBe('https://accounts.zoho.in/oauth/v2/token');
      expect(String(body)).toContain('client_id=org-client-id');
      expect(String(body)).toContain('client_secret=org-secret');
    });

    it('refreshOAuthToken falls back to the platform app when the organization never configured its own (backward compatible)', async () => {
      await service.connectWithOAuth(org, 'zoho', { accessToken: 'at-old', refreshToken: 'rt-1', expiresInSeconds: -10 }, { skipSync: true });
      http.post.mockReturnValueOnce(of({ data: { access_token: 'at-new', expires_in: 3600 } }));

      await service.resolveAuth(org, 'zoho');
      const [, body] = http.post.mock.calls[0];
      expect(String(body)).toContain('client_id=zoho-client-id');
      expect(String(body)).toContain('client_secret=zoho-client-secret');
    });

    it('one organization\'s saved app credentials are never visible to another organization', async () => {
      const otherOrg = `${PREFIX}-org-other-${seq}`;
      await service.saveOAuthAppCredentials(org, 'zoho', { clientId: 'org-a-client-id', clientSecret: 'org-a-secret' });
      const otherStatus = await service.getOAuthAppCredentialsStatus(otherOrg, 'zoho');
      expect(otherStatus).toEqual({ configured: false });
      const otherResolved = await service.resolveOAuthAppCredentials(otherOrg, 'zoho');
      expect(otherResolved).toBeNull();
      await credentialModel.deleteOne({ organizationId: otherOrg, provider: 'zoho' });
    });
  });

  // Org-wide integration sharing's other half: not just "every user in the
  // SAME org reaches the SAME connection" (true by construction — resolveAuth
  // takes no userId at all, see its own signature) but "two DIFFERENT orgs'
  // connections for the identical provider name never cross" — the actual
  // security-relevant invariant. Gorilla Dash (basic auth, not OAuth) picked
  // deliberately to prove this holds outside the oauth2 code path too.
  describe('connected-integration cross-organization isolation (gorilladash)', () => {
    it('two organizations each connect gorilladash independently — resolveAuth for one never returns the other\'s credentials', async () => {
      const orgA = `${PREFIX}-gd-org-a-${seq}`;
      const orgB = `${PREFIX}-gd-org-b-${seq}`;
      await service.connectWithAuth(orgA, 'gorilladash', { authType: 'basic', credentials: { username: 'org-a-key', password: 'org-a-secret' } } as never, { skipSync: true });
      await service.connectWithAuth(orgB, 'gorilladash', { authType: 'basic', credentials: { username: 'org-b-key', password: 'org-b-secret' } } as never, { skipSync: true });

      const resolvedA = await service.resolveAuth(orgA, 'gorilladash');
      const resolvedB = await service.resolveAuth(orgB, 'gorilladash');
      expect(resolvedA?.credentials).toMatchObject({ username: 'org-a-key', password: 'org-a-secret' });
      expect(resolvedB?.credentials).toMatchObject({ username: 'org-b-key', password: 'org-b-secret' });
      // Neither organization's own credentials ever equal the other's — the
      // concrete failure mode a cross-tenant leak would produce.
      expect(resolvedA?.credentials).not.toMatchObject({ username: 'org-b-key' });
      expect(resolvedB?.credentials).not.toMatchObject({ username: 'org-a-key' });

      await credentialModel.deleteMany({ organizationId: { $in: [orgA, orgB] }, provider: 'gorilladash' });
    });

    it('a disconnected/never-configured organization gets a clear "not connected" result, never another organization\'s data', async () => {
      const connectedOrg = `${PREFIX}-gd-connected-${seq}`;
      const neverConnectedOrg = `${PREFIX}-gd-never-${seq}`;
      await service.connectWithAuth(connectedOrg, 'gorilladash', { authType: 'basic', credentials: { username: 'k', password: 's' } } as never, { skipSync: true });

      const resolved = await service.resolveAuth(neverConnectedOrg, 'gorilladash');
      expect(resolved).toBeNull();

      await credentialModel.deleteOne({ organizationId: connectedOrg, provider: 'gorilladash' });
    });
  });

  // Org-wide integration sharing's first half, actually exercised rather
  // than argued from resolveAuth's signature alone (see the comment on the
  // describe block above this one): an owner/admin connects once, and every
  // OTHER authorized identity in that same organization — simulated here by
  // calling resolveAuth repeatedly with no connecting action in between,
  // exactly what a second user's/a brand-new user's/a concurrent AI tool
  // call's own request would do — reaches the identical stored connection,
  // with zero additional writes. A generic custom provider (bearer auth via
  // connectWithAuth, the same path DynamicExecutorService uses for any
  // connector) is used here specifically to prove this isn't special-cased
  // to one named provider.
  describe('organization-wide integration sharing across multiple users', () => {
    it('a second, independently-resolving caller in the same organization reaches the identical connection the admin made — no reconnect, no duplicate document', async () => {
      const sharedOrg = `${PREFIX}-share-org-${seq}`;
      const provider = 'sharedcrm';
      // Simulates the owner/admin's one-time "Connect" action.
      await service.connectWithAuth(
        sharedOrg,
        provider,
        { authType: 'bearer', credentials: { bearerToken: 'admin-connected-token' } } as never,
        { skipSync: true },
      );

      // Simulates a completely separate authenticated request for a
      // DIFFERENT user in the same org (e.g. a consultant, or a brand-new
      // user created after the admin connected) — resolveAuth takes no
      // user identity at all, so this is the actual, exercised proof that
      // such a caller needs no connection of their own.
      const asSecondUser = await service.resolveAuth(sharedOrg, provider);
      const asAdmin = await service.resolveAuth(sharedOrg, provider);

      expect(asSecondUser?.credentials).toMatchObject({ bearerToken: 'admin-connected-token' });
      // Same stored document both times — not two coincidentally-identical
      // but separately-created rows.
      expect(asSecondUser?.integrationId.toString()).toBe(asAdmin?.integrationId.toString());

      const count = await credentialModel.countDocuments({ organizationId: sharedOrg, provider });
      expect(count).toBe(1);

      await credentialModel.deleteOne({ organizationId: sharedOrg, provider });
    });

    it('many concurrent resolutions (simulating several users/AI tool calls at once) never create a duplicate connection', async () => {
      const sharedOrg = `${PREFIX}-share-concurrent-${seq}`;
      const provider = 'sharedcrm';
      await service.connectWithAuth(
        sharedOrg,
        provider,
        { authType: 'bearer', credentials: { bearerToken: 'shared-token' } } as never,
        { skipSync: true },
      );

      const results = await Promise.all(Array.from({ length: 5 }, () => service.resolveAuth(sharedOrg, provider)));
      for (const result of results) {
        expect(result?.credentials).toMatchObject({ bearerToken: 'shared-token' });
      }
      const ids = new Set(results.map((r) => r?.integrationId.toString()));
      expect(ids.size).toBe(1);

      const count = await credentialModel.countDocuments({ organizationId: sharedOrg, provider });
      expect(count).toBe(1);

      await credentialModel.deleteOne({ organizationId: sharedOrg, provider });
    });

    it('a user/request with no real organization identity fails closed — never matches any organization\'s connection', async () => {
      const sharedOrg = `${PREFIX}-share-failclosed-${seq}`;
      const provider = 'sharedcrm';
      await service.connectWithAuth(
        sharedOrg,
        provider,
        { authType: 'bearer', credentials: { bearerToken: 'shared-token' } } as never,
        { skipSync: true },
      );

      expect(await service.resolveAuth('', provider)).toBeNull();
      expect(await service.resolveAuth(undefined as never, provider)).toBeNull();

      await credentialModel.deleteOne({ organizationId: sharedOrg, provider });
    });
  });

  // Gmail's own Google OAuth app (gmail.service.ts's resolveAppCredentials)
  // reuses this exact same mechanism, just under the fixed 'platform' scope
  // every AI provider credential (Anthropic/Sarvam/ElevenLabs/Groq) already
  // uses (admin-integrations.controller.ts) — these tests exercise that
  // literal real usage (provider='gmail', organizationId='platform'), not
  // just the generic Zoho case above, since a platform admin's save/status
  // calls and GmailService's resolve calls must agree on exactly this.
  describe('platform-wide OAuth app credentials (Gmail\'s shared Google app)', () => {
    const PLATFORM = 'platform';

    afterEach(async () => {
      await credentialModel.deleteOne({ organizationId: PLATFORM, provider: 'gmail' });
    });

    it('a platform admin saving Gmail app credentials persists them encrypted under the platform scope', async () => {
      await service.saveOAuthAppCredentials(PLATFORM, 'gmail', { clientId: 'platform-google-client-id', clientSecret: 'platform-google-secret' });
      const doc = await credentialModel.findOne({ organizationId: PLATFORM, provider: 'gmail' });
      expect(doc?.oauthClientId).toBe('platform-google-client-id');
      expect(doc?.oauthClientSecretEncrypted).not.toContain('platform-google-secret');

      const status = await service.getOAuthAppCredentialsStatus(PLATFORM, 'gmail');
      expect(status).toMatchObject({ configured: true, clientId: 'platform-google-client-id' });
      expect(JSON.stringify(status)).not.toContain('platform-google-secret');
    });

    it('is completely separate from any real organization\'s own Zoho/Salesforce app credentials, even if both happen to be configured', async () => {
      await service.saveOAuthAppCredentials(PLATFORM, 'gmail', { clientId: 'platform-google-client-id', clientSecret: 'platform-google-secret' });
      await service.saveOAuthAppCredentials(org, 'zoho', { clientId: 'org-zoho-client-id', clientSecret: 'org-zoho-secret' });

      expect(await service.resolveOAuthAppCredentials(org, 'gmail')).toBeNull();
      expect(await service.resolveOAuthAppCredentials(PLATFORM, 'zoho')).toBeNull();
      const platformGmail = await service.resolveOAuthAppCredentials(PLATFORM, 'gmail');
      expect(platformGmail).toMatchObject({ clientId: 'platform-google-client-id' });
    });

    it('reports not configured, and resolves null, before any admin has saved anything', async () => {
      expect(await service.getOAuthAppCredentialsStatus(PLATFORM, 'gmail')).toEqual({ configured: false });
      expect(await service.resolveOAuthAppCredentials(PLATFORM, 'gmail')).toBeNull();
    });
  });

  // Xero is platform-wide like Gmail above (no per-org app), but — unlike
  // every other oauth2 provider here — rotates its refresh token on every
  // use, so this specifically covers that the NEW refresh token actually
  // gets persisted (refreshTokenEncrypted), not just the access token.
  describe('xero (platform-wide app, rotating refresh token)', () => {
    it('resolveAuth refreshes a near-expiry Xero token and persists the ROTATED refresh token', async () => {
      await service.connectWithOAuth(
        org,
        'xero',
        { accessToken: 'xero-at-old', refreshToken: 'xero-rt-old', expiresInSeconds: -10, baseUrl: 'https://api.xero.com/api.xro/2.0', oauthMeta: { tenantId: 't-1', tenantName: 'Demo Co' } },
        { skipSync: true },
      );
      http.post.mockReturnValueOnce(of({ data: { access_token: 'xero-at-new', refresh_token: 'xero-rt-new', expires_in: 1800 } }));

      const resolved = await service.resolveAuth(org, 'xero');
      expect(resolved?.credentials.accessToken).toBe('xero-at-new');
      expect(resolved?.oauthMeta).toMatchObject({ tenantId: 't-1', tenantName: 'Demo Co' });
      const [url, body] = http.post.mock.calls[0];
      expect(url).toBe('https://identity.xero.com/connect/token');
      expect(String(body)).toContain('client_id=xero-client-id');

      const doc = await credentialModel.findOne({ organizationId: org, provider: 'xero' });
      expect(doc?.refreshTokenEncrypted).not.toContain('xero-rt-old');
      expect(doc?.refreshTokenEncrypted).not.toContain('xero-rt-new');

      // Prove it's actually the NEW token stored, not just "changed" —
      // a second refresh must send xero-rt-new, not the original.
      http.post.mockClear();
      http.post.mockReturnValueOnce(of({ data: { access_token: 'xero-at-newer', refresh_token: 'xero-rt-newer', expires_in: 1800 } }));
      await credentialModel.updateOne({ organizationId: org, provider: 'xero' }, { $set: { tokenExpiresAt: new Date(Date.now() - 10_000) } });
      await service.resolveAuth(org, 'xero');
      const [, secondBody] = http.post.mock.calls[0];
      expect(String(secondBody)).toContain('refresh_token=xero-rt-new');
    });

    it('resolveAuth exposes oauthMeta (including tenantId) for DynamicExecutorService\'s Xero-tenant-id header', async () => {
      await service.connectWithOAuth(
        org,
        'xero',
        { accessToken: 'at', refreshToken: 'rt', expiresInSeconds: 3600, baseUrl: 'https://api.xero.com/api.xro/2.0', oauthMeta: { tenantId: 'tenant-abc', tenantName: 'Demo Co' } },
        { skipSync: true },
      );
      const resolved = await service.resolveAuth(org, 'xero');
      expect(resolved?.oauthMeta).toMatchObject({ tenantId: 'tenant-abc' });
      expect(resolved?.baseUrl).toBe('https://api.xero.com/api.xro/2.0');
    });

    it('prefers a platform-saved app over the env var fallback, same precedence as Gmail', async () => {
      await service.saveOAuthAppCredentials('platform', 'xero', { clientId: 'saved-xero-client', clientSecret: 'saved-xero-secret' });
      await service.connectWithOAuth(org, 'xero', { accessToken: 'at', refreshToken: 'rt', expiresInSeconds: -10 }, { skipSync: true });
      http.post.mockReturnValueOnce(of({ data: { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 1800 } }));

      await service.resolveAuth(org, 'xero');
      const [, body] = http.post.mock.calls[0];
      expect(String(body)).toContain('client_id=saved-xero-client');

      await credentialModel.deleteOne({ organizationId: 'platform', provider: 'xero' });
    });

    it('marks needs_reauth when Xero refuses the refresh, same failure contract as Zoho/Salesforce', async () => {
      await service.connectWithOAuth(org, 'xero', { accessToken: 'at', refreshToken: 'dead-rt', expiresInSeconds: -10 }, { skipSync: true });
      http.post.mockReturnValueOnce(throwError(() => new Error('invalid_grant')));

      const resolved = await service.resolveAuth(org, 'xero');
      expect(resolved?.credentials.accessToken).toBeUndefined();
      const doc = await credentialModel.findOne({ organizationId: org, provider: 'xero' });
      expect(doc?.status).toBe('needs_reauth');
    });
  });

  // Zoho Books — same org-owned-app-first / platform-fallback precedence
  // and non-rotating refresh token as Zoho CRM ('zoho' above), but this
  // specifically proves the two never cross-contaminate (a Books connection
  // and a CRM connection for the SAME organization are two independent
  // documents) and that baseUrl is correctly derived as apiDomain +
  // '/books/v3' (not the bare apiDomain the 'zoho' CRM branch uses).
  describe('zohobooks (independent of Zoho CRM, derived /books/v3 baseUrl)', () => {
    it('resolveAuth refreshes a near-expiry Zoho Books token and derives the /books/v3 baseUrl from booksApiDomain', async () => {
      await service.connectWithOAuth(
        org,
        'zohobooks',
        { accessToken: 'books-at-old', refreshToken: 'books-rt', expiresInSeconds: -10, oauthMeta: { accountsServer: 'https://accounts.zoho.com', booksApiDomain: 'https://www.zohoapis.com', booksOrganizationId: 'b-org-1' } },
        { skipSync: true },
      );
      http.post.mockReturnValueOnce(of({ data: { access_token: 'books-at-new', expires_in: 3600, api_domain: 'https://www.zohoapis.com' } }));

      const resolved = await service.resolveAuth(org, 'zohobooks');
      expect(resolved?.credentials.accessToken).toBe('books-at-new');
      expect(resolved?.baseUrl).toBe('https://www.zohoapis.com/books/v3');
      expect(resolved?.oauthMeta?.booksOrganizationId).toBe('b-org-1');
      const [, body] = http.post.mock.calls[0];
      expect(String(body)).toContain('client_id=zohobooks-client-id');
    });

    it('a Zoho CRM connection and a Zoho Books connection for the same organization are fully independent documents', async () => {
      await service.connectWithOAuth(org, 'zoho', { accessToken: 'crm-at', refreshToken: 'crm-rt', expiresInSeconds: 3600, oauthMeta: { apiDomain: 'https://www.zohoapis.com' } }, { skipSync: true });
      await service.connectWithOAuth(org, 'zohobooks', { accessToken: 'books-at', refreshToken: 'books-rt', expiresInSeconds: 3600, oauthMeta: { booksApiDomain: 'https://www.zohoapis.com' } }, { skipSync: true });

      const crm = await service.resolveAuth(org, 'zoho');
      const books = await service.resolveAuth(org, 'zohobooks');
      expect(crm?.credentials.accessToken).toBe('crm-at');
      expect(books?.credentials.accessToken).toBe('books-at');
      // CRM's baseUrl is the bare apiDomain; Books' is apiDomain + /books/v3
      // — proves the two refresh/resolve branches never bleed into each other.
      expect(crm?.baseUrl).toBe('https://www.zohoapis.com');
      expect(books?.baseUrl).toBe('https://www.zohoapis.com/books/v3');
    });

    it('prefers the organization\'s own saved Books app credentials over the platform app, same as Zoho CRM', async () => {
      await service.saveOAuthAppCredentials(org, 'zohobooks', { clientId: 'org-books-client', clientSecret: 'org-books-secret' });
      await service.connectWithOAuth(org, 'zohobooks', { accessToken: 'at', refreshToken: 'rt', expiresInSeconds: -10 }, { skipSync: true });
      http.post.mockReturnValueOnce(of({ data: { access_token: 'at-new', expires_in: 3600 } }));

      await service.resolveAuth(org, 'zohobooks');
      const [, body] = http.post.mock.calls[0];
      expect(String(body)).toContain('client_id=org-books-client');
    });

    it('marks needs_reauth when Zoho Books refuses the refresh', async () => {
      await service.connectWithOAuth(org, 'zohobooks', { accessToken: 'at', refreshToken: 'dead-rt', expiresInSeconds: -10 }, { skipSync: true });
      http.post.mockReturnValueOnce(throwError(() => new Error('invalid_grant')));

      const resolved = await service.resolveAuth(org, 'zohobooks');
      expect(resolved?.credentials.accessToken).toBeUndefined();
      const doc = await credentialModel.findOne({ organizationId: org, provider: 'zohobooks' });
      expect(doc?.status).toBe('needs_reauth');
    });
  });

  // Zoho Payroll — same per-org "bring your own app" pattern as zohobooks
  // above, but a fully separate credential document (provider
  // 'zohopayroll') with its own derived baseUrl (/payroll/v1, from
  // payrollApiDomain — not booksApiDomain/apiDomain).
  describe('zohopayroll (independent of Zoho CRM/Books, derived /payroll/v1 baseUrl)', () => {
    it('resolveAuth refreshes a near-expiry Zoho Payroll token and derives the /payroll/v1 baseUrl from payrollApiDomain', async () => {
      await service.connectWithOAuth(
        org,
        'zohopayroll',
        { accessToken: 'payroll-at-old', refreshToken: 'payroll-rt', expiresInSeconds: -10, oauthMeta: { accountsServer: 'https://accounts.zoho.com', payrollApiDomain: 'https://www.zohoapis.com', payrollOrganizationId: 'p-org-1' } },
        { skipSync: true },
      );
      http.post.mockReturnValueOnce(of({ data: { access_token: 'payroll-at-new', expires_in: 3600, api_domain: 'https://www.zohoapis.com' } }));

      const resolved = await service.resolveAuth(org, 'zohopayroll');
      expect(resolved?.credentials.accessToken).toBe('payroll-at-new');
      expect(resolved?.baseUrl).toBe('https://www.zohoapis.com/payroll/v1');
      expect(resolved?.oauthMeta?.payrollOrganizationId).toBe('p-org-1');
      const [, body] = http.post.mock.calls[0];
      expect(String(body)).toContain('client_id=zohopayroll-client-id');
    });

    it('a Zoho Books connection and a Zoho Payroll connection for the same organization are fully independent documents', async () => {
      await service.connectWithOAuth(org, 'zohobooks', { accessToken: 'books-at', refreshToken: 'books-rt', expiresInSeconds: 3600, oauthMeta: { booksApiDomain: 'https://www.zohoapis.com' } }, { skipSync: true });
      await service.connectWithOAuth(org, 'zohopayroll', { accessToken: 'payroll-at', refreshToken: 'payroll-rt', expiresInSeconds: 3600, oauthMeta: { payrollApiDomain: 'https://www.zohoapis.com' } }, { skipSync: true });

      const books = await service.resolveAuth(org, 'zohobooks');
      const payroll = await service.resolveAuth(org, 'zohopayroll');
      expect(books?.credentials.accessToken).toBe('books-at');
      expect(payroll?.credentials.accessToken).toBe('payroll-at');
      // Books' baseUrl is apiDomain + /books/v3; Payroll's is apiDomain +
      // /payroll/v1 — proves the two refresh/resolve branches never bleed
      // into each other.
      expect(books?.baseUrl).toBe('https://www.zohoapis.com/books/v3');
      expect(payroll?.baseUrl).toBe('https://www.zohoapis.com/payroll/v1');
    });

    it('prefers the organization\'s own saved Payroll app credentials over the platform app, same as Zoho Books', async () => {
      await service.saveOAuthAppCredentials(org, 'zohopayroll', { clientId: 'org-payroll-client', clientSecret: 'org-payroll-secret' });
      await service.connectWithOAuth(org, 'zohopayroll', { accessToken: 'at', refreshToken: 'rt', expiresInSeconds: -10 }, { skipSync: true });
      http.post.mockReturnValueOnce(of({ data: { access_token: 'at-new', expires_in: 3600 } }));

      await service.resolveAuth(org, 'zohopayroll');
      const [, body] = http.post.mock.calls[0];
      expect(String(body)).toContain('client_id=org-payroll-client');
    });

    it('marks needs_reauth when Zoho Payroll refuses the refresh', async () => {
      await service.connectWithOAuth(org, 'zohopayroll', { accessToken: 'at', refreshToken: 'dead-rt', expiresInSeconds: -10 }, { skipSync: true });
      http.post.mockReturnValueOnce(throwError(() => new Error('invalid_grant')));

      const resolved = await service.resolveAuth(org, 'zohopayroll');
      expect(resolved?.credentials.accessToken).toBeUndefined();
      const doc = await credentialModel.findOne({ organizationId: org, provider: 'zohopayroll' });
      expect(doc?.status).toBe('needs_reauth');
    });
  });

  // MYOB — platform-wide like Xero (non-rotating refresh, same as Zoho),
  // but specifically proves the secondary credential pair (company-file
  // username/password — the one thing no other provider here needs) is
  // stored and surfaced through resolveAuth independently of the primary
  // OAuth token, and that saving it never touches the token itself.
  describe('myob (secondary credential pair alongside OAuth)', () => {
    it('resolveAuth refreshes a near-expiry MYOB token using the platform app', async () => {
      await service.connectWithOAuth(
        org,
        'myob',
        { accessToken: 'myob-at-old', refreshToken: 'myob-rt', expiresInSeconds: -10, baseUrl: 'https://api.myob.com/accountright/biz-1', oauthMeta: { myobClientId: 'myob-client-id' } },
        { skipSync: true },
      );
      http.post.mockReturnValueOnce(of({ data: { access_token: 'myob-at-new', expires_in: 1200 } }));

      const resolved = await service.resolveAuth(org, 'myob');
      expect(resolved?.credentials.accessToken).toBe('myob-at-new');
      expect(resolved?.baseUrl).toBe('https://api.myob.com/accountright/biz-1');
      expect(resolved?.oauthMeta?.myobClientId).toBe('myob-client-id');
      const [url, body] = http.post.mock.calls[0];
      expect(url).toBe('https://secure.myob.com/oauth2/v1/authorize');
      expect(String(body)).toContain('client_id=myob-client-id');
    });

    it('saveSecondaryCredentials stores the company-file pair encrypted, without touching the OAuth token', async () => {
      await service.connectWithOAuth(org, 'myob', { accessToken: 'at', refreshToken: 'rt', expiresInSeconds: 3600, baseUrl: 'https://api.myob.com/accountright/biz-1' }, { skipSync: true });
      await service.saveSecondaryCredentials(org, 'myob', { username: 'cf-admin', password: 'cf-super-secret' });

      const doc = await credentialModel.findOne({ organizationId: org, provider: 'myob' });
      expect(doc?.secondaryCredentialsEncrypted).toBeDefined();
      expect(doc?.secondaryCredentialsEncrypted).not.toContain('cf-super-secret');
      // The primary token is completely untouched by this call.
      expect(doc?.credentialsEncrypted).not.toContain('cf-super-secret');

      const resolved = await service.resolveAuth(org, 'myob');
      expect(resolved?.credentials.accessToken).toBe('at');
      expect(resolved?.secondaryCredentials).toEqual({ username: 'cf-admin', password: 'cf-super-secret' });
    });

    it('resolveAuth returns no secondaryCredentials before they have ever been saved', async () => {
      await service.connectWithOAuth(org, 'myob', { accessToken: 'at', refreshToken: 'rt', expiresInSeconds: 3600 }, { skipSync: true });
      const resolved = await service.resolveAuth(org, 'myob');
      expect(resolved?.secondaryCredentials).toBeUndefined();
    });

    it('marks needs_reauth when MYOB refuses the refresh, same contract as every other oauth2 provider', async () => {
      await service.connectWithOAuth(org, 'myob', { accessToken: 'at', refreshToken: 'dead-rt', expiresInSeconds: -10 }, { skipSync: true });
      http.post.mockReturnValueOnce(throwError(() => new Error('invalid_grant')));

      const resolved = await service.resolveAuth(org, 'myob');
      expect(resolved?.credentials.accessToken).toBeUndefined();
      const doc = await credentialModel.findOne({ organizationId: org, provider: 'myob' });
      expect(doc?.status).toBe('needs_reauth');
    });
  });
});
