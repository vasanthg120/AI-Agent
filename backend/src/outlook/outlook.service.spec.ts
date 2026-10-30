import { BadRequestException } from '@nestjs/common';
import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { of } from 'rxjs';
import { EncryptionService } from '../common/encryption/encryption.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { IntegrationCredential, IntegrationCredentialDocument, IntegrationCredentialSchema } from '../integrations/schemas/integration-credential.schema';
import { OutlookService } from './outlook.service';

// Regression coverage for removing the hard MS_GRAPH_CLIENT_SECRET .env
// dependency (see outlook.service.ts's own resolveAppCredentials comment):
// a platform admin's saved Client ID/Secret (POST /integrations/admin/
// outlook/app-credentials) must take precedence; the env vars remain a
// backward-compatible fallback for a deployment that set them before this
// existed; and Outlook must fail with a clear, actionable error — never a
// confusing downstream Microsoft error — when neither is configured.
const PREFIX = `jest-outlook-app-creds-${Date.now()}`;

describe('OutlookService — platform OAuth app credentials (real Mongo)', () => {
  let connection: Connection;
  let credentialModel: Model<IntegrationCredentialDocument>;
  let integrations: IntegrationsService;
  let http: { post: jest.Mock; get: jest.Mock };
  let seq = 0;

  const buildOutlookService = (envClientId?: string, envClientSecret?: string) => {
    const config = {
      get: (key: string) => {
        const values: Record<string, string | undefined> = {
          'integrations.msGraph.clientId': envClientId,
          'integrations.msGraph.clientSecret': envClientSecret,
          'integrations.msGraph.redirectUri': 'https://app.example.com/outlook/callback',
        };
        return values[key];
      },
    };
    const connectionModel = {
      updateMany: jest.fn().mockResolvedValue({}),
      findOneAndUpdate: jest.fn().mockResolvedValue({}),
    };
    return new OutlookService(
      config as never,
      http as never,
      new EncryptionService({ get: () => `${PREFIX}-key-at-least-32-bytes-long!!` } as never),
      { findAll: async () => [] } as never,
      integrations,
      connectionModel as never,
      null as never,
    );
  };

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([{ name: IntegrationCredential.name, schema: IntegrationCredentialSchema }]),
      ],
    }).compile();
    connection = moduleRef.get(getConnectionToken());
    credentialModel = moduleRef.get(getModelToken(IntegrationCredential.name));
    await credentialModel.init();

    const encryption = new EncryptionService({ get: () => `${PREFIX}-key-at-least-32-bytes-long!!` } as never);
    http = { post: jest.fn(), get: jest.fn() };
    integrations = new IntegrationsService(
      credentialModel,
      encryption,
      http as never,
      { sign: () => 'jwt' } as never,
      { get: () => undefined } as never,
      { reconcile: jest.fn() } as never,
    );
  });

  afterAll(async () => {
    await credentialModel.deleteMany({ organizationId: 'platform', provider: 'outlook' });
    await connection.close();
  });

  beforeEach(() => {
    seq += 1;
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await credentialModel.deleteOne({ organizationId: 'platform', provider: 'outlook' });
  });

  it('uses the platform-admin-saved Client ID when one has been configured, ignoring any env values', async () => {
    await integrations.saveOAuthAppCredentials('platform', 'outlook', {
      clientId: `db-client-id-${seq}`,
      clientSecret: `db-client-secret-${seq}`,
    });
    const service = buildOutlookService('env-client-id', 'env-client-secret');

    const url = await service.buildAuthorizeUrl('state-123');

    expect(url).toContain(`client_id=db-client-id-${seq}`);
    expect(url).not.toContain('env-client-id');
  });

  it('falls back to MS_GRAPH_CLIENT_ID/SECRET env vars when nothing is saved in the database', async () => {
    const service = buildOutlookService(`env-client-id-${seq}`, `env-client-secret-${seq}`);

    const url = await service.buildAuthorizeUrl('state-123');

    expect(url).toContain(`client_id=env-client-id-${seq}`);
  });

  it('throws a clear OUTLOOK_APP_CREDENTIALS_REQUIRED error when neither the database nor env vars are configured', async () => {
    const service = buildOutlookService(undefined, undefined);

    const error = await service.buildAuthorizeUrl('state-123').catch((e) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.response).toMatchObject({ code: 'OUTLOOK_APP_CREDENTIALS_REQUIRED' });
  });

  it('never includes the client secret anywhere in the authorize URL', async () => {
    await integrations.saveOAuthAppCredentials('platform', 'outlook', {
      clientId: `db-client-id-${seq}`,
      clientSecret: `super-secret-value-${seq}`,
    });
    const service = buildOutlookService();

    const url = await service.buildAuthorizeUrl('state-123');

    expect(url).not.toContain(`super-secret-value-${seq}`);
  });

  it('getOAuthAppCredentialsStatus never returns the raw secret for the outlook provider, only a fixed mask', async () => {
    await integrations.saveOAuthAppCredentials('platform', 'outlook', {
      clientId: `db-client-id-${seq}`,
      clientSecret: `super-secret-value-${seq}`,
    });

    const status = await integrations.getOAuthAppCredentialsStatus('platform', 'outlook');

    expect(status.configured).toBe(true);
    expect(status.clientId).toBe(`db-client-id-${seq}`);
    expect(status.clientSecretMasked).toBe('••••••••••••');
    expect(JSON.stringify(status)).not.toContain(`super-secret-value-${seq}`);
  });

  it('the token exchange sends the saved (not env) client secret to Microsoft, once a database credential exists', async () => {
    await integrations.saveOAuthAppCredentials('platform', 'outlook', {
      clientId: `db-client-id-${seq}`,
      clientSecret: `db-client-secret-${seq}`,
    });
    const service = buildOutlookService('env-client-id', 'env-client-secret');
    http.post.mockReturnValueOnce(
      of({ data: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'Mail.Read' } }),
    );
    http.get.mockReturnValueOnce(of({ data: { mail: 'someone@example.com' } }));

    await service.handleCallback('auth-code', `user-${seq}`, undefined);

    const [, sentBody] = http.post.mock.calls[0];
    expect(String(sentBody)).toContain(`client_secret=db-client-secret-${seq}`);
    expect(String(sentBody)).not.toContain('env-client-secret');
  });
});
