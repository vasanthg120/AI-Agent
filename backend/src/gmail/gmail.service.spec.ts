import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { of } from 'rxjs';
import { EncryptionService } from '../common/encryption/encryption.service';
import { GmailService } from './gmail.service';
import { GmailConnection, GmailConnectionDocument, GmailConnectionSchema } from './schemas/gmail-connection.schema';

// Real Mongo + real encryption, HTTP mocked — same split every other OAuth
// spec in this session uses (zoho.service.spec.ts, integrations-oauth.spec.ts).
const PREFIX = `jest-gmail-${Date.now()}`;

describe('GmailService (real Mongo)', () => {
  let connection: Connection;
  let connectionModel: Model<GmailConnectionDocument>;
  let service: GmailService;
  const http = { post: jest.fn(), get: jest.fn() };
  const config = {
    get: (key: string) => {
      const values: Record<string, string> = {
        'integrations.google.clientId': 'google-client-id',
        'integrations.google.clientSecret': 'google-client-secret',
        'integrations.google.redirectUri': 'http://localhost:3000/gmail/callback',
      };
      return values[key];
    },
  } as never;
  let seq = 0;
  let userId: string;
  // Default: nothing saved in the platform DB, so resolveAppCredentials()
  // falls back to the `config` mock's env values above — matches every
  // existing test's expectation (google-client-id) without having to repeat
  // this mock in each one. Tests that care about the platform-app-vs-env
  // precedence override it directly.
  const integrations = { resolveOAuthAppCredentials: jest.fn().mockResolvedValue(null) };

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(uri), MongooseModule.forFeature([{ name: GmailConnection.name, schema: GmailConnectionSchema }])],
    }).compile();
    connectionModel = moduleRef.get(getModelToken(GmailConnection.name));
    connection = moduleRef.get(getConnectionToken());
    await connectionModel.init();

    const encryption = new EncryptionService({ get: () => `${PREFIX}-key` } as never);
    service = new GmailService(config, http as never, encryption, integrations as never, connectionModel);
  });

  beforeEach(() => {
    seq += 1;
    userId = `${PREFIX}-user-${seq}`;
    jest.clearAllMocks();
    integrations.resolveOAuthAppCredentials.mockResolvedValue(null);
  });

  afterAll(async () => {
    await connectionModel.deleteMany({ userId: { $regex: `^${PREFIX}` } });
    await connection.close();
  });

  it('buildAuthorizeUrl requests offline access + consent (required for Google to issue a refresh token) and carries the given state', async () => {
    const url = new URL(await service.buildAuthorizeUrl('signed-state-value'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('google-client-id');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toContain('gmail.readonly');
    expect(url.searchParams.get('scope')).toContain('gmail.send');
    expect(url.searchParams.get('state')).toBe('signed-state-value');
  });

  describe('platform app credentials (admin-configured Google OAuth app)', () => {
    it('prefers the platform-saved app over the env var fallback', async () => {
      integrations.resolveOAuthAppCredentials.mockResolvedValue({ clientId: 'platform-client-id', clientSecret: 'platform-secret' });
      const url = new URL(await service.buildAuthorizeUrl('s'));
      expect(url.searchParams.get('client_id')).toBe('platform-client-id');
    });

    it('falls back to GOOGLE_CLIENT_ID/SECRET env vars when nothing is saved in the platform DB (backward compatible)', async () => {
      const url = new URL(await service.buildAuthorizeUrl('s'));
      expect(url.searchParams.get('client_id')).toBe('google-client-id');
    });

    it('throws a clear, user-facing error when neither the platform DB nor env vars have credentials', async () => {
      integrations.resolveOAuthAppCredentials.mockResolvedValue(null);
      const noEnvConfig = { get: () => undefined } as never;
      const noEnvService = new GmailService(noEnvConfig, http as never, new EncryptionService({ get: () => `${PREFIX}-key` } as never), integrations as never, connectionModel);

      await expect(noEnvService.buildAuthorizeUrl('s')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'GMAIL_APP_CREDENTIALS_REQUIRED' }),
      });
      expect(await noEnvService.isAppConfigured()).toBe(false);
    });

    it('isAppConfigured reports true once either source has credentials', async () => {
      expect(await service.isAppConfigured()).toBe(true); // env fallback present
      integrations.resolveOAuthAppCredentials.mockResolvedValue({ clientId: 'x', clientSecret: 'y' });
      expect(await service.isAppConfigured()).toBe(true); // platform-saved present
    });
  });

  // The callback URL must never silently default to localhost — an unset or
  // malformed GOOGLE_REDIRECT_URI now fails loudly (configuration.ts no
  // longer hardcodes a fallback at all), and both buildAuthorizeUrl and
  // exchangeCode must resolve the identical value (Google rejects a token
  // exchange whose redirect_uri doesn't match the original authorize
  // request).
  describe('callback URL resolution (production-safety)', () => {
    function configWith(overrides: Record<string, string | undefined>): ConfigService {
      const base: Record<string, string | undefined> = {
        'integrations.google.clientId': 'google-client-id',
        'integrations.google.clientSecret': 'google-client-secret',
        'integrations.google.redirectUri': 'http://localhost:3000/gmail/callback',
        nodeEnv: 'development',
      };
      const values = { ...base, ...overrides };
      return { get: (key: string) => values[key] } as never;
    }
    function serviceWith(cfg: ConfigService) {
      return new GmailService(cfg, http as never, new EncryptionService({ get: () => `${PREFIX}-key` } as never), integrations as never, connectionModel);
    }

    it('throws GMAIL_CALLBACK_URL_REQUIRED when the redirect URI is unset, even with valid credentials', async () => {
      const svc = serviceWith(configWith({ 'integrations.google.redirectUri': '' }));
      await expect(svc.buildAuthorizeUrl('s')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'GMAIL_CALLBACK_URL_REQUIRED' }),
      });
      expect(await svc.isAppConfigured()).toBe(false);
    });

    it('throws GMAIL_CALLBACK_URL_INVALID when the redirect URI is not a well-formed URL', async () => {
      const svc = serviceWith(configWith({ 'integrations.google.redirectUri': 'not-a-url' }));
      await expect(svc.buildAuthorizeUrl('s')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'GMAIL_CALLBACK_URL_INVALID' }),
      });
    });

    it('rejects a non-https redirect URI in production', async () => {
      const svc = serviceWith(configWith({ nodeEnv: 'production', 'integrations.google.redirectUri': 'http://pollen.haive.tech/gmail/callback' }));
      await expect(svc.buildAuthorizeUrl('s')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'GMAIL_CALLBACK_URL_INVALID' }),
      });
    });

    it('accepts an https redirect URI in production', async () => {
      const svc = serviceWith(configWith({ nodeEnv: 'production', 'integrations.google.redirectUri': 'https://pollen.haive.tech/gmail/callback' }));
      const url = new URL(await svc.buildAuthorizeUrl('s'));
      expect(url.searchParams.get('redirect_uri')).toBe('https://pollen.haive.tech/gmail/callback');
    });

    it('credential errors take priority over callback-url errors when both are missing (existing error stays stable)', async () => {
      const svc = serviceWith(configWith({ 'integrations.google.clientId': '', 'integrations.google.clientSecret': '', 'integrations.google.redirectUri': '' }));
      integrations.resolveOAuthAppCredentials.mockResolvedValueOnce(null);
      await expect(svc.buildAuthorizeUrl('s')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'GMAIL_APP_CREDENTIALS_REQUIRED' }),
      });
    });

    it('uses the exact same redirect_uri for the authorize request and the token exchange', async () => {
      const cfg = configWith({});
      const svc = serviceWith(cfg);
      const authorizeUrl = new URL(await svc.buildAuthorizeUrl('s'));

      http.post.mockReturnValueOnce(of({ data: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'gmail.readonly' } }));
      http.get.mockReturnValueOnce(of({ data: { email: 'consistency@gmail.com' } }));
      await svc.handleCallback('auth-code', `${PREFIX}-consistency-user`);

      const sentBody = new URLSearchParams(http.post.mock.calls[0][1] as string);
      expect(sentBody.get('redirect_uri')).toBe(authorizeUrl.searchParams.get('redirect_uri'));
      await connectionModel.deleteMany({ userId: `${PREFIX}-consistency-user` });
    });
  });

  describe('handleCallback', () => {
    function mockGoogleResponses(email: string) {
      http.post.mockReturnValueOnce(of({ data: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'gmail.readonly' } }));
      http.get.mockReturnValueOnce(of({ data: { email } }));
    }

    it('creates a new connection, active, with tokens encrypted at rest', async () => {
      mockGoogleResponses('user@gmail.com');
      const result = await service.handleCallback('auth-code', userId);
      expect(result).toEqual({ email: 'user@gmail.com' });

      const doc = await connectionModel.findOne({ userId, email: 'user@gmail.com' });
      expect(doc?.isActive).toBe(true);
      expect(doc?.status).toBe('connected');
      expect(doc?.accessToken).not.toContain('at-1');
      expect(doc?.refreshToken).not.toContain('rt-1');
    });

    it('connecting a second account makes it active and demotes the first (both stay connected — multi-account)', async () => {
      mockGoogleResponses('first@gmail.com');
      await service.handleCallback('code-1', userId);
      mockGoogleResponses('second@gmail.com');
      await service.handleCallback('code-2', userId);

      const accounts = await service.listAccounts(userId);
      expect(accounts).toHaveLength(2);
      expect(accounts.find((a) => a.email === 'second@gmail.com')?.isActive).toBe(true);
      expect(accounts.find((a) => a.email === 'first@gmail.com')?.isActive).toBe(false);
      // Demoted, not disconnected.
      expect(accounts.find((a) => a.email === 'first@gmail.com')?.status).toBe('connected');
    });

    it('reconnecting the same email recovers a needs_reauth row back to connected', async () => {
      mockGoogleResponses('stale@gmail.com');
      await service.handleCallback('code-1', userId);
      await connectionModel.updateOne({ userId, email: 'stale@gmail.com' }, { $set: { status: 'needs_reauth' } });

      mockGoogleResponses('stale@gmail.com');
      await service.handleCallback('code-2', userId);

      const status = await service.getStatus(userId);
      expect(status).toEqual({ connected: true, email: 'stale@gmail.com', needsReauth: false });
    });
  });

  describe('getStatus', () => {
    it('reports not connected when nothing is set up', async () => {
      expect(await service.getStatus(userId)).toEqual({ connected: false, email: undefined, needsReauth: false });
    });

    it('reports connected: false (but surfaces needsReauth) for an active account marked needs_reauth', async () => {
      await connectionModel.create({
        userId,
        email: 'dead@gmail.com',
        accessToken: 'x',
        refreshToken: 'y',
        expiresAt: new Date(),
        isActive: true,
        status: 'needs_reauth',
      });
      expect(await service.getStatus(userId)).toEqual({ connected: false, email: 'dead@gmail.com', needsReauth: true });
    });
  });

  describe('setActive / disconnect', () => {
    beforeEach(async () => {
      await connectionModel.create({ userId, email: 'a@gmail.com', accessToken: 'x', refreshToken: 'y', expiresAt: new Date(), isActive: true });
      await connectionModel.create({ userId, email: 'b@gmail.com', accessToken: 'x', refreshToken: 'y', expiresAt: new Date(), isActive: false });
    });

    it('setActive switches the active account and throws for an unknown email', async () => {
      await service.setActive(userId, 'b@gmail.com');
      const accounts = await service.listAccounts(userId);
      expect(accounts.find((a) => a.email === 'b@gmail.com')?.isActive).toBe(true);
      expect(accounts.find((a) => a.email === 'a@gmail.com')?.isActive).toBe(false);

      await expect(service.setActive(userId, 'nope@gmail.com')).rejects.toThrow(NotFoundException);
    });

    it('disconnecting the active account promotes the most recently connected remaining one', async () => {
      await service.disconnect(userId, 'a@gmail.com');
      const accounts = await service.listAccounts(userId);
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({ email: 'b@gmail.com', isActive: true });
    });

    it('disconnecting a non-active account leaves the active one untouched', async () => {
      await service.disconnect(userId, 'b@gmail.com');
      const accounts = await service.listAccounts(userId);
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({ email: 'a@gmail.com', isActive: true });
    });
  });

  describe('cross-user isolation', () => {
    it('one user can never see or modify another user\'s Gmail accounts', async () => {
      const otherUserId = `${PREFIX}-user-other-${seq}`;
      await connectionModel.create({ userId, email: 'mine@gmail.com', accessToken: 'x', refreshToken: 'y', expiresAt: new Date(), isActive: true });
      await connectionModel.create({ userId: otherUserId, email: 'theirs@gmail.com', accessToken: 'x', refreshToken: 'y', expiresAt: new Date(), isActive: true });

      const myAccounts = await service.listAccounts(userId);
      expect(myAccounts).toEqual([expect.objectContaining({ email: 'mine@gmail.com' })]);

      // Can't set the other user's account active by naming it under my own id.
      await expect(service.setActive(userId, 'theirs@gmail.com')).rejects.toThrow(NotFoundException);
      // Can't disconnect it either — a no-op, not an error, but verifiably leaves it alone.
      await service.disconnect(userId, 'theirs@gmail.com');
      const theirAccounts = await service.listAccounts(otherUserId);
      expect(theirAccounts).toEqual([expect.objectContaining({ email: 'theirs@gmail.com', isActive: true })]);

      await connectionModel.deleteMany({ userId: otherUserId });
    });
  });
});
