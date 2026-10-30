import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model, Types } from 'mongoose';
import { of } from 'rxjs';
import { DynamicExecutorService } from './dynamic-executor.service';
import { IntegrationEndpoint, IntegrationEndpointDocument, IntegrationEndpointSchema } from './schemas/integration-endpoint.schema';
import { IntegrationResource, IntegrationResourceDocument, IntegrationResourceSchema } from './schemas/integration-resource.schema';

// Real Mongo for the resource/endpoint lookup (the actual thing this service
// adds value over a bare HTTP client), IntegrationsService.resolveAuth
// mocked — this is specifically about the Xero-tenant-id header addition:
// scoped to provider==='xero' with a tenantId present, and proven to never
// leak into any other provider's request.
const PREFIX = `jest-dynexec-${Date.now()}`;

describe('DynamicExecutorService — provider-specific extra headers', () => {
  let connection: Connection;
  let resourceModel: Model<IntegrationResourceDocument>;
  let endpointModel: Model<IntegrationEndpointDocument>;
  let service: DynamicExecutorService;
  const http = { request: jest.fn() };
  const integrations = { resolveAuth: jest.fn() };
  let seq = 0;
  let org: string;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: IntegrationResource.name, schema: IntegrationResourceSchema },
          { name: IntegrationEndpoint.name, schema: IntegrationEndpointSchema },
        ]),
      ],
    }).compile();
    resourceModel = moduleRef.get(getModelToken(IntegrationResource.name));
    endpointModel = moduleRef.get(getModelToken(IntegrationEndpoint.name));
    connection = moduleRef.get(getConnectionToken());
    await resourceModel.init();
    await endpointModel.init();
    service = new DynamicExecutorService(resourceModel, endpointModel, integrations as never, http as never);
  });

  beforeEach(() => {
    seq += 1;
    org = `${PREFIX}-org-${seq}`;
    jest.clearAllMocks();
    http.request.mockReturnValue(of({ status: 200, data: { ok: true } }));
  });

  afterAll(async () => {
    await resourceModel.deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await endpointModel.deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await connection.close();
  });

  // Resource/endpoint docs have no "provider" field of their own (see the
  // schema — they're keyed purely by integrationId); the provider name only
  // ever enters via each test's own resolveAuth mock + execute() call.
  async function seedEndpoint() {
    const integrationId = new Types.ObjectId();
    const resource = await resourceModel.create({ organizationId: org, integrationId, name: 'Invoices', key: 'invoices' });
    await endpointModel.create({
      organizationId: org,
      integrationId,
      resourceId: resource._id,
      name: 'List',
      key: 'list',
      method: 'GET',
      path: '/Invoices',
    });
    return integrationId;
  }

  it('adds Xero-tenant-id for a xero provider with a tenantId in oauthMeta', async () => {
    const integrationId = await seedEndpoint();
    integrations.resolveAuth.mockResolvedValue({
      integrationId,
      authType: 'oauth2',
      credentials: { accessToken: 'at' },
      baseUrl: 'https://api.xero.com/api.xro/2.0',
      oauthMeta: { tenantId: 'tenant-abc' },
    });

    await service.execute(org, 'xero', 'invoices', 'list', {});

    const [request] = http.request.mock.calls[0];
    expect(request.headers['Xero-tenant-id']).toBe('tenant-abc');
    expect(request.headers.Authorization).toBe('Bearer at');
  });

  it('never adds the header for a different oauth2 provider, even one with an unrelated oauthMeta', async () => {
    // A real, publicly-resolvable domain — assertPublicHttpUrl's SSRF guard
    // does a genuine DNS lookup, so a fake *.salesforce.com-shaped host
    // would fail that check before ever reaching the header logic this test
    // actually cares about.
    const integrationId = await seedEndpoint();
    integrations.resolveAuth.mockResolvedValue({
      integrationId,
      authType: 'oauth2',
      credentials: { accessToken: 'at' },
      baseUrl: 'https://example.com',
      oauthMeta: { instanceUrl: 'https://example.com' },
    });

    await service.execute(org, 'salesforce', 'invoices', 'list', {});

    const [request] = http.request.mock.calls[0];
    expect(request.headers['Xero-tenant-id']).toBeUndefined();
  });

  it('omits the header for xero itself when no tenant has been selected yet (pending multi-tenant connection)', async () => {
    const integrationId = await seedEndpoint();
    integrations.resolveAuth.mockResolvedValue({
      integrationId,
      authType: 'oauth2',
      credentials: { accessToken: 'at' },
      baseUrl: 'https://api.xero.com/api.xro/2.0',
      oauthMeta: { tenants: JSON.stringify([{ tenantId: 't-1', tenantName: 'A' }]) },
    });

    await service.execute(org, 'xero', 'invoices', 'list', {});

    const [request] = http.request.mock.calls[0];
    expect(request.headers['Xero-tenant-id']).toBeUndefined();
  });

  it('injects organization_id for zohobooks when a books organization has been selected', async () => {
    const integrationId = await seedEndpoint();
    integrations.resolveAuth.mockResolvedValue({
      integrationId,
      authType: 'oauth2',
      credentials: { accessToken: 'at' },
      baseUrl: 'https://www.zohoapis.com/books/v3',
      oauthMeta: { booksOrganizationId: 'b-org-1' },
    });

    await service.execute(org, 'zohobooks', 'invoices', 'list', { query: { date_start: '2026-01-01' } });

    const [request] = http.request.mock.calls[0];
    expect(request.params).toMatchObject({ organization_id: 'b-org-1', date_start: '2026-01-01' });
  });

  it('omits organization_id for zohobooks when no organization has been selected yet', async () => {
    const integrationId = await seedEndpoint();
    integrations.resolveAuth.mockResolvedValue({
      integrationId,
      authType: 'oauth2',
      credentials: { accessToken: 'at' },
      baseUrl: 'https://www.zohoapis.com/books/v3',
      oauthMeta: { organizations: JSON.stringify([{ organizationId: 'b-org-1', name: 'A' }]) },
    });

    await service.execute(org, 'zohobooks', 'invoices', 'list', {});

    const [request] = http.request.mock.calls[0];
    expect(request.params.organization_id).toBeUndefined();
  });

  it('injects organization_id for zohopayroll when a payroll organization has been selected, and keeps it independent of zohobooks', async () => {
    const integrationId = await seedEndpoint();
    integrations.resolveAuth.mockResolvedValue({
      integrationId,
      authType: 'oauth2',
      credentials: { accessToken: 'at' },
      baseUrl: 'https://www.zohoapis.com/payroll/v1',
      oauthMeta: { payrollOrganizationId: 'p-org-1', booksOrganizationId: 'should-never-be-used' },
    });

    await service.execute(org, 'zohopayroll', 'invoices', 'list', {});

    const [request] = http.request.mock.calls[0];
    expect(request.params.organization_id).toBe('p-org-1');
  });

  it('an endpoint-supplied organization_id is never overridden by the injected one', async () => {
    const integrationId = await seedEndpoint();
    integrations.resolveAuth.mockResolvedValue({
      integrationId,
      authType: 'oauth2',
      credentials: { accessToken: 'at' },
      baseUrl: 'https://www.zohoapis.com/books/v3',
      oauthMeta: { booksOrganizationId: 'b-org-1' },
    });

    await service.execute(org, 'zohobooks', 'invoices', 'list', { query: { organization_id: 'explicit-override' } });

    const [request] = http.request.mock.calls[0];
    expect(request.params.organization_id).toBe('explicit-override');
  });

  it.each(['zoho', 'zohobooks', 'zohopayroll'])('uses Zoho-oauthtoken instead of Bearer for provider %s', async (provider) => {
    const integrationId = await seedEndpoint();
    integrations.resolveAuth.mockResolvedValue({
      integrationId,
      authType: 'oauth2',
      credentials: { accessToken: 'zoho-at' },
      baseUrl: 'https://www.zohoapis.com',
      oauthMeta: {},
    });

    await service.execute(org, provider, 'invoices', 'list', {});

    const [request] = http.request.mock.calls[0];
    expect(request.headers.Authorization).toBe('Zoho-oauthtoken zoho-at');
  });

  it('every other oauth2 provider keeps the generic Bearer scheme', async () => {
    const integrationId = await seedEndpoint();
    integrations.resolveAuth.mockResolvedValue({
      integrationId,
      authType: 'oauth2',
      credentials: { accessToken: 'at' },
      baseUrl: 'https://example.com',
      oauthMeta: {},
    });

    await service.execute(org, 'salesforce', 'invoices', 'list', {});

    const [request] = http.request.mock.calls[0];
    expect(request.headers.Authorization).toBe('Bearer at');
  });

  it('adds x-myobapi-key/version and x-myobapi-cftoken for myob once both credential pairs are present', async () => {
    const integrationId = await seedEndpoint();
    integrations.resolveAuth.mockResolvedValue({
      integrationId,
      authType: 'oauth2',
      credentials: { accessToken: 'myob-at' },
      baseUrl: 'https://api.myob.com/accountright/biz-1',
      oauthMeta: { myobClientId: 'myob-client-abc' },
      secondaryCredentials: { username: 'cf-admin', password: 'cf-pass' },
    });

    await service.execute(org, 'myob', 'invoices', 'list', {});

    const [request] = http.request.mock.calls[0];
    expect(request.headers['x-myobapi-key']).toBe('myob-client-abc');
    expect(request.headers['x-myobapi-version']).toBe('v2');
    expect(request.headers['x-myobapi-cftoken']).toBe(Buffer.from('cf-admin:cf-pass').toString('base64'));
    expect(request.headers.Authorization).toBe('Bearer myob-at');
  });

  it('omits x-myobapi-cftoken for myob when the company-file credentials have not been entered yet', async () => {
    const integrationId = await seedEndpoint();
    integrations.resolveAuth.mockResolvedValue({
      integrationId,
      authType: 'oauth2',
      credentials: { accessToken: 'myob-at' },
      baseUrl: 'https://api.myob.com/accountright/biz-1',
      oauthMeta: { myobClientId: 'myob-client-abc' },
      secondaryCredentials: undefined,
    });

    await service.execute(org, 'myob', 'invoices', 'list', {});

    const [request] = http.request.mock.calls[0];
    expect(request.headers['x-myobapi-key']).toBe('myob-client-abc');
    expect(request.headers['x-myobapi-cftoken']).toBeUndefined();
  });

  it('never adds any MYOB header for a different provider', async () => {
    const integrationId = await seedEndpoint();
    integrations.resolveAuth.mockResolvedValue({
      integrationId,
      authType: 'oauth2',
      credentials: { accessToken: 'at' },
      baseUrl: 'https://example.com',
      oauthMeta: { myobClientId: 'should-never-be-used' },
    });

    await service.execute(org, 'salesforce', 'invoices', 'list', {});

    const [request] = http.request.mock.calls[0];
    expect(request.headers['x-myobapi-key']).toBeUndefined();
  });
});
