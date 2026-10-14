import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { of } from 'rxjs';
import { nameScore } from '../data-sources/canonical-mapping';
import { DataSourcesService } from '../data-sources/data-sources.service';
import { MappingIntelligenceService } from '../data-sources/mapping-intelligence.service';
import { CRM_PROVIDERS, PUSH_PROVIDERS, connectionOf } from '../data-sources/provider-catalog';
import { DataSource, DataSourceDocument, DataSourceSchema } from '../data-sources/schemas/data-source.schema';
import { WebhookSourcesService } from '../data-sources/webhook-sources.service';
import { CrmIntegrationsService } from './crm-integrations.service';

const PREFIX = `jest-crmint-${Date.now()}`;

describe('provider catalog', () => {
  it('names Pantheras CRM and treats Hoops as its own push provider', () => {
    expect(CRM_PROVIDERS.prospectconnect.label).toBe('Pantheras CRM');
    expect(CRM_PROVIDERS.hoops).toMatchObject({ label: 'Hoops CRM', syncSupported: false, fieldMappings: {} });
    expect(connectionOf(CRM_PROVIDERS.hoops)).toBe('push');
    expect(connectionOf(CRM_PROVIDERS.prospectconnect)).toBe('pull');
    expect(PUSH_PROVIDERS).toEqual(expect.arrayContaining(['hoops', 'zapier']));
    // Hoops carries none of Pantheras' field names.
    expect(JSON.stringify(CRM_PROVIDERS.hoops)).not.toContain('monetary_value');
  });

  it('scores field names: exact known names high, look-alikes as "probably", unrelated 0', () => {
    expect(nameScore('email', 'Email')).toBeGreaterThanOrEqual(90);
    expect(nameScore('amount', 'SalesDocTotal')).toBeGreaterThanOrEqual(50);
    expect(nameScore('amount', 'SalesDocTotal')).toBeLessThan(85);
    expect(nameScore('externalId', 'customer.id')).toBeLessThan(nameScore('externalId', 'id'));
    expect(nameScore('email', 'Colour')).toBe(0);
  });
});

// Against a real Mongo: a CRM with its own field names is mapped by
// suggestion + review, never silently; and each organization only ever sees
// its own integration, mapping and records.
describe('CRM integrations (real Mongo)', () => {
  let connection: Connection;
  let sources: Model<DataSourceDocument>;
  let dataSources: DataSourcesService;
  let webhooks: WebhookSourcesService;
  let mapping: MappingIntelligenceService;
  let crm: CrmIntegrationsService;
  const http = { post: jest.fn() };
  const reservations = { reserve: jest.fn(), settle: jest.fn(), release: jest.fn(), resolveTenantKey: (org: string) => org };
  const integrations = { resolveAuth: jest.fn(), connectWithAuth: jest.fn(), disconnect: jest.fn() };
  let seq = 0;
  let org: string;
  const caller = () => ({ sub: 'admin-1', organizationId: org }) as never;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(uri), MongooseModule.forFeature([{ name: DataSource.name, schema: DataSourceSchema }])],
    }).compile();
    sources = moduleRef.get(getModelToken(DataSource.name));
    connection = moduleRef.get(getConnectionToken());
    await sources.init();
    const config = { get: () => undefined } as never;
    const jwt = { sign: () => 'jwt' } as never;
    dataSources = new DataSourcesService(sources, connection, http as never, jwt, config);
    webhooks = new WebhookSourcesService(sources, connection, dataSources, config);
    mapping = new MappingIntelligenceService(connection, dataSources, reservations as never, http as never, jwt, config);
    crm = new CrmIntegrationsService(connection, dataSources, webhooks, integrations as never, {} as never, http as never, jwt, config);
  });

  beforeEach(() => {
    seq += 1;
    org = `${PREFIX}-org-${seq}`;
    jest.clearAllMocks();
  });

  afterAll(async () => {
    for (const name of ['crm_deals', 'crm_contacts', 'crm_source_samples', 'crm_sync_runs', 'crm_mapping_versions', 'integration_credentials']) {
      await connection.collection(name).deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    }
    await sources.deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await connection.close();
  });

  it('sets Hoops up as a push CRM: an address and a key, then records arrive under the Hoops source only', async () => {
    const before = await crm.list(org);
    expect(before.map((i) => [i.id, i.status])).toEqual([
      ['prospectconnect', 'not_connected'],
      ['hoops', 'not_connected'],
      ['gorilladash', 'not_connected'],
    ]);
    // Each CRM asks only for what it needs.
    expect(before[0].setup.fields.map((f) => f.key)).toEqual(['apiToken', 'baseUrl']);
    expect(before[1].setup.fields).toEqual([]);
    expect(before[1].setup.limitations.join(' ')).toContain('SalesDocs');
    expect(before[2].setup.fields.map((f) => f.key)).toEqual(['apiKey', 'apiSecret']);

    const { integration, webhookKey } = await crm.connect(org, 'hoops', {});
    expect(webhookKey).toMatch(/^hvk_/);
    expect(integration).toMatchObject({ id: 'hoops', connection: 'push', status: 'waiting' });
    expect(integration.source?.webhook?.paths).toEqual({
      deals: `/data-source-webhooks/${integration.source!.id}/deals`,
      contacts: `/data-source-webhooks/${integration.source!.id}/contacts`,
    });
    await expect(crm.connect(org, 'hoops', {})).rejects.toThrow('already set up');
    await expect(crm.syncNow(org, 'hoops')).rejects.toThrow('nothing to pull');

    // Hoops' own field names — nothing like Pantheras'.
    await webhooks.ingest(integration.source!.id, 'contacts', webhookKey, { CustomerID: 'C-1', 'Client Name': 'Acme Print', Email: 'ap@acme.com' });
    await webhooks.ingest(integration.source!.id, 'deals', webhookKey, [
      { JobNumber: 'J-7', JobTitle: '200 caps', SalesDocTotal: '1,450.00', JobState: 'Invoiced' },
      { JobNumber: 'J-8', JobTitle: 'Banner', SalesDocTotal: '300', JobState: 'In production' },
    ]);
    const after = (await crm.list(org))[1];
    // Jobs arrived but none could be stored yet (no ID field mapped): that needs the customer's attention, as a mapping problem.
    expect(after.status).toBe('needs_attention');
    expect(after.source).toMatchObject({ health: 'failing', totalRecords: 1 });
    expect(after.source?.error).toMatchObject({ kind: 'mapping' });
    expect(await crm.history(org, 'hoops')).toHaveLength(2);

    // Jobs had no field literally called "id": nothing was guessed, so nothing was stored — it waits for review.
    expect(after.source!.records).toEqual({ deals: 0, contacts: 0 + 1 });

    const suggestion = await mapping.suggest(caller(), integration.source!.id, false);
    const deals = suggestion.modules.find((m) => m.module === 'deals')!;
    const byKey = Object.fromEntries(deals.fields.map((f) => [f.key, f]));
    expect(byKey.externalId).toMatchObject({ source: null, needsReview: true, required: true });
    expect(byKey.amount).toMatchObject({ source: 'SalesDocTotal', method: 'auto', needsReview: true });
    expect(byKey.amount.example).toBe('1,450.00');
    expect(deals.sourceFields.map((f) => f.path)).toEqual(expect.arrayContaining(['JobNumber', 'JobTitle', 'SalesDocTotal', 'JobState']));
    expect(suggestion.reviewCount).toBeGreaterThan(0);

    // The AI is asked only about what's still unsure, and can only answer with real fields of this CRM.
    http.post.mockReturnValue(
      of({
        data: {
          mappings: [
            { target: 'externalId', source: 'JobNumber', confidence: 92, reason: 'Unique job code' },
            { target: 'name', source: 'JobTitle', confidence: 90, reason: 'Job title' },
            { target: 'status', source: 'JobState', confidence: 88, reason: 'Short state word' },
            { target: 'owner', source: 'NotAField', confidence: 99, reason: 'invented' },
          ],
        },
      }),
    );
    const withAi = await mapping.suggest(caller(), integration.source!.id, true);
    const aiDeals = Object.fromEntries(withAi.modules.find((m) => m.module === 'deals')!.fields.map((f) => [f.key, f]));
    expect(aiDeals.externalId).toMatchObject({ source: 'JobNumber', method: 'ai', confidence: 92, needsReview: false });
    expect(aiDeals.owner.source).toBeNull();
    expect(reservations.reserve).toHaveBeenCalled();
    expect(reservations.settle).toHaveBeenCalled();
    // Suggesting changed nothing.
    expect((await sources.findById(integration.source!.id).lean())?.fieldMappings.deals).toBeUndefined();

    // Review: preview, validation, save (versioned), restore.
    const chosen = { deals: { externalId: 'JobNumber', name: 'JobTitle', amount: 'SalesDocTotal', status: 'JobState' } };
    const preview = await mapping.preview(org, integration.source!.id, chosen);
    expect(preview.rows.find((r) => r.module === 'deals')!.values).toMatchObject({
      'Record ID': 'J-7',
      Name: '200 caps',
      Value: 1450,
      Status: 'won (from “Invoiced”)',
    });
    expect(preview.problems).toEqual([]);
    expect(mapping.validate({ deals: { name: 'JobTitle' } }, ['deals'])[0]).toContain('Record ID');
    await expect(mapping.save(caller(), integration.source!.id, { deals: { name: 'JobTitle' } })).rejects.toThrow('Record ID');

    await mapping.save(caller(), integration.source!.id, chosen);
    await webhooks.ingest(integration.source!.id, 'deals', webhookKey, {
      JobNumber: 'J-7',
      JobTitle: '200 caps',
      SalesDocTotal: '1,450.00',
      JobState: 'Invoiced',
    });
    const stored = await connection.collection('crm_deals').findOne({ organizationId: org, externalId: 'J-7' });
    expect(stored).toMatchObject({ name: '200 caps', monetaryValue: 1450, dealStatus: 'won', sourceProvider: 'hoops', dataSourceId: integration.source!.id });
    expect((await crm.list(org))[1]).toMatchObject({ status: 'connected', source: { health: 'healthy', totalRecords: 2 } });

    // One CRM field can't feed two HaiVE fields.
    await expect(mapping.save(caller(), integration.source!.id, { deals: { ...chosen.deals, name: 'JobNumber' } })).rejects.toThrow('mapped to two');
    const { status: _dropped, ...withoutStatus } = chosen.deals;
    await mapping.save(caller(), integration.source!.id, { deals: withoutStatus });
    expect((await sources.findById(integration.source!.id).lean())?.fieldMappings.deals?.status).toBeUndefined();
    const versions = await mapping.versions(org, integration.source!.id);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    await mapping.restore(caller(), integration.source!.id, 2);
    expect((await sources.findById(integration.source!.id).lean())?.fieldMappings.deals).toMatchObject({ name: 'JobTitle', status: 'JobState' });

    // Another organization: no Hoops, no mapping, no records, no versions.
    const other = `${org}-other`;
    expect((await crm.list(other))[1].status).toBe('not_connected');
    await expect(mapping.suggest({ sub: 'x', organizationId: other } as never, integration.source!.id, false)).rejects.toThrow('Data source not found.');
    await expect(mapping.versions(other, integration.source!.id)).rejects.toThrow('Data source not found.');
    expect(await crm.history(other, 'hoops')).toEqual([]);

    // Disconnecting stops records; the key no longer works.
    expect((await crm.disconnect(org, 'hoops')).status).toBe('not_connected');
    await expect(webhooks.ingest(integration.source!.id, 'deals', webhookKey, { JobNumber: 'J-9' })).rejects.toThrow('Unknown webhook address or key.');
  });

  it('connects a pull CRM only if its data can really be read, and shows a failed sync in plain words', async () => {
    integrations.resolveAuth.mockResolvedValue(null);
    // Saving the credential is what creates the data source.
    integrations.connectWithAuth.mockImplementation(async (organizationId: string) => {
      await connection.collection('integration_credentials').insertOne({ organizationId, provider: 'prospectconnect' });
      await dataSources.reconcile(organizationId);
    });
    integrations.disconnect.mockImplementation(async (organizationId: string, provider: string) => {
      await connection.collection('integration_credentials').deleteMany({ organizationId, provider });
    });

    await expect(crm.connect(org, 'prospectconnect', { apiToken: '' })).rejects.toThrow('Enter the api token.');
    await expect(crm.connect(org, 'prospectconnect', { apiToken: 't', baseUrl: 'ftp://x' })).rejects.toThrow('https://');

    // The CRM refuses the token: nothing stays connected.
    http.post.mockReturnValue(of({ data: { status: 'error', kind: 'auth', message: 'x', detail: 'HTTPError: 401 for url https://api/x' } }));
    await expect(crm.connect(org, 'prospectconnect', { apiToken: 'bad-token' })).rejects.toThrow('Pantheras CRM didn’t accept these details');
    expect(await connection.collection('integration_credentials').countDocuments({ organizationId: org })).toBe(0);
    expect((await crm.list(org))[0].status).toBe('not_connected');

    http.post.mockReturnValue(of({ data: { status: 'ok', modules: { deals: { records: 50, fields: 12 }, quotes: { records: 20, fields: 30 } } } }));
    const { integration, discovery } = await crm.connect(org, 'prospectconnect', { apiToken: 'Bearer good-token' });
    expect(integrations.connectWithAuth).toHaveBeenLastCalledWith(
      org,
      'prospectconnect',
      { authType: 'bearer', credentials: { bearerToken: 'good-token' }, baseUrl: 'https://api.prospectconnect.ai' },
      { skipSync: true },
    );
    expect(discovery).toEqual({ deals: { records: 50, fields: 12 }, quotes: { records: 20, fields: 30 } });
    expect(integration).toMatchObject({ id: 'prospectconnect', label: 'Pantheras CRM', connection: 'pull', status: 'connected' });
    expect(integration.source).toMatchObject({ health: 'not_synced', label: 'Pantheras CRM', isDefault: true });

    // A failed sync: what the customer reads, and the technical detail kept apart.
    await sources.updateOne(
      { _id: integration.source!.id },
      {
        $set: {
          'sync.lastStatus': 'error',
          'sync.lastError': 'HaiVE couldn’t sign in to this CRM.',
          'sync.lastErrorKind': 'auth',
          'sync.lastErrorDetail': 'HTTPError: 401 Unauthorized',
        },
      },
    );
    const failing = (await crm.list(org))[0];
    expect(failing.status).toBe('needs_attention');
    expect(failing.source?.error).toEqual({ message: 'HaiVE couldn’t sign in to this CRM.', kind: 'auth', detail: 'HTTPError: 401 Unauthorized' });
    expect(failing.source?.error?.message).not.toMatch(/401|HTTP/);

    await crm.disconnect(org, 'prospectconnect');
    expect((await crm.list(org))[0].status).toBe('not_connected');
  });
});
