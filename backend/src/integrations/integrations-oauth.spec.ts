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
});
