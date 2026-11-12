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
  it('names Pantheras CRM and reads Hoops through its own API, once a night', () => {
    expect(CRM_PROVIDERS.prospectconnect.label).toBe('Pantheras CRM');
    expect(CRM_PROVIDERS.hoops).toMatchObject({ label: 'Hoops CRM', syncSupported: true, integrationProviders: ['hoops'] });
    expect(connectionOf(CRM_PROVIDERS.hoops)).toBe('pull');
    expect(CRM_PROVIDERS.hoops.syncDefaults?.window).toEqual({ utcOffsetMinutes: 600, start: '19:00', end: '05:00', label: 'AEST' });
    expect(connectionOf(CRM_PROVIDERS.prospectconnect)).toBe('pull');
    expect(PUSH_PROVIDERS).toEqual(['zapier']);
    // Hoops carries none of Pantheras' field names; a sale is won when its job is created (as Hoops' jobs report counts it).
    expect(JSON.stringify(CRM_PROVIDERS.hoops)).not.toContain('monetary_value');
    expect(CRM_PROVIDERS.hoops.statusMapping).toEqual({ won: ['job'], lost: ['voided'] });
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

  it('a pushed source (Zapier): an address and a key, then records arrive under that source only, mapped by suggestion + review', async () => {
    const before = await crm.list(org);
    expect(before.map((i) => [i.id, i.status])).toEqual([
      ['prospectconnect', 'not_connected'],
      ['hoops', 'not_connected'],
      ['gorilladash', 'not_connected'],
      ['zoho', 'not_connected'],
      ['salesforce', 'not_connected'],
    ]);
    // Each CRM asks only for what it needs.
    expect(before[0].setup.fields.map((f) => f.key)).toEqual(['apiToken', 'baseUrl']);
    expect(before[1].setup.fields.map((f) => f.key)).toEqual(['apiKey', 'history', 'currency', 'baseUrl']);
    expect(before[1].setup.limitations.join(' ')).toContain('7:00pm AEST');
    expect(before[2].setup.fields.map((f) => f.key)).toEqual(['apiKey', 'apiSecret']);

    const created = await webhooks.create(org, { label: 'Job app', terminology: { deal: 'Job', contact: 'Customer' } });
    const integration = { source: { id: created.id } };
    const webhookKey = created.key;
    expect(webhookKey).toMatch(/^hvk_/);
    expect(created.webhook.paths).toEqual({
      deals: `/data-source-webhooks/${created.id}/deals`,
      contacts: `/data-source-webhooks/${created.id}/contacts`,
      accounts: `/data-source-webhooks/${created.id}/accounts`,
    });

    // Hoops' own field names — nothing like Pantheras'.
    await webhooks.ingest(integration.source!.id, 'contacts', webhookKey, { CustomerID: 'C-1', 'Client Name': 'Acme Print', Email: 'ap@acme.com' });
    await webhooks.ingest(integration.source!.id, 'deals', webhookKey, [
      { JobNumber: 'J-7', JobTitle: '200 caps', SalesDocTotal: '1,450.00', JobState: 'Completed' },
      { JobNumber: 'J-8', JobTitle: 'Banner', SalesDocTotal: '300', JobState: 'In production' },
    ]);
    const after = await sources.findById(created.id).lean();
    // Jobs arrived but none could be stored yet (no ID field mapped): that needs the customer's attention, as a mapping problem.
    expect(after?.sync).toMatchObject({ lastStatus: 'error', lastErrorKind: 'mapping' });
    expect(await connection.collection('crm_sync_runs').countDocuments({ organizationId: org, dataSourceId: created.id })).toBe(2);

    // Jobs had no field literally called "id": nothing was guessed, so nothing was stored — it waits for review.
    expect(await connection.collection('crm_deals').countDocuments({ organizationId: org, dataSourceId: created.id })).toBe(0);
    expect(await connection.collection('crm_contacts').countDocuments({ organizationId: org, dataSourceId: created.id })).toBe(1);

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
      Status: 'won (from “Completed”)',
    });
    expect(preview.problems).toEqual([]);
    expect(mapping.validate({ deals: { name: 'JobTitle' } }, ['deals'])[0]).toContain('Record ID');
    await expect(mapping.save(caller(), integration.source!.id, { deals: { name: 'JobTitle' } })).rejects.toThrow('Record ID');

    await mapping.save(caller(), integration.source!.id, chosen);
    await webhooks.ingest(integration.source!.id, 'deals', webhookKey, {
      JobNumber: 'J-7',
      JobTitle: '200 caps',
      SalesDocTotal: '1,450.00',
      JobState: 'Completed',
    });
    const stored = await connection.collection('crm_deals').findOne({ organizationId: org, externalId: 'J-7' });
    expect(stored).toMatchObject({ name: '200 caps', monetaryValue: 1450, dealStatus: 'won', sourceProvider: 'zapier', dataSourceId: created.id });
    expect((await sources.findById(created.id).lean())?.sync.lastError).toBeUndefined();

    // One CRM field can't feed two HaiVE fields.
    await expect(mapping.save(caller(), integration.source!.id, { deals: { ...chosen.deals, name: 'JobNumber' } })).rejects.toThrow('mapped to two');
    const { status: _dropped, ...withoutStatus } = chosen.deals;
    await mapping.save(caller(), integration.source!.id, { deals: withoutStatus });
    expect((await sources.findById(integration.source!.id).lean())?.fieldMappings.deals?.status).toBeUndefined();
    const versions = await mapping.versions(org, integration.source!.id);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    await mapping.restore(caller(), integration.source!.id, 2);
    expect((await sources.findById(integration.source!.id).lean())?.fieldMappings.deals).toMatchObject({ name: 'JobTitle', status: 'JobState' });

    // Another organization: no mapping, no records, no versions.
    const other = `${org}-other`;
    await expect(mapping.suggest({ sub: 'x', organizationId: other } as never, integration.source!.id, false)).rejects.toThrow('Data source not found.');
    await expect(mapping.versions(other, integration.source!.id)).rejects.toThrow('Data source not found.');

    // Disconnecting stops records; the key no longer works.
    await webhooks.disconnect(org, created.id);
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

  it('connects Hoops with its API key: checked by reading a first page, then read once a night, its history a little each night', async () => {
    integrations.resolveAuth.mockResolvedValue(null);
    integrations.connectWithAuth.mockImplementation(async (organizationId: string, provider: string) => {
      await connection.collection('integration_credentials').updateOne({ organizationId, provider }, { $set: { organizationId, provider } }, { upsert: true });
      await dataSources.reconcile(organizationId);
    });
    integrations.disconnect.mockImplementation(async (organizationId: string, provider: string) => {
      await connection.collection('integration_credentials').deleteMany({ organizationId, provider });
    });
    // Set up earlier, when Hoops could only send records through Zapier: its key since removed, its sync off, its old words.
    await sources.create({
      organizationId: org,
      key: 'hoops',
      provider: 'hoops',
      label: 'Hoops CRM',
      status: 'active',
      isDefault: false,
      modules: ['deals', 'contacts'],
      terminology: { deal: 'Job', quote: 'SalesDoc', contact: 'Customer', account: 'Company' },
      fieldMappings: {},
      statusMapping: { won: ['won'], lost: ['lost'] },
      sync: { enabled: false, intervalMinutes: 10, lastStatus: 'never' },
      metadata: { webhookReceived: 0 },
    });
    await dataSources.reconcile(org);
    // Nothing sends to it any more and it has no API key yet: not connected.
    expect((await crm.list(org))[1].status).toBe('not_connected');

    await expect(crm.connect(org, 'hoops', { apiKey: '' })).rejects.toThrow('Enter the api key.');
    await expect(crm.connect(org, 'hoops', { apiKey: 'k', currency: 'rupees' })).rejects.toThrow('3-letter code');
    await expect(crm.connect(org, 'hoops', { apiKey: 'k', history: 'forever' })).rejects.toThrow('how much history');
    await expect(crm.connect(org, 'hoops', { apiKey: 'k', baseUrl: 'http://api.hoopscrm.com/rest/api' })).rejects.toThrow('https://');

    // Hoops refuses the key: nothing is kept.
    http.post.mockReturnValue(of({ data: { status: 'error', kind: 'auth', message: 'x', detail: 'AdapterError: Hoops rejected the API key (HTTP 403).' } }));
    await expect(crm.connect(org, 'hoops', { apiKey: 'wrong' })).rejects.toThrow('Hoops CRM didn’t accept these details');
    expect(await connection.collection('integration_credentials').countDocuments({ organizationId: org })).toBe(0);

    const modules = {
      deals: { records: 5, fields: 60 },
      quotes: { records: 5, fields: 60 },
      contacts: { records: 7, fields: 9 },
      accounts: { records: 4, fields: 20 },
    };
    http.post.mockReturnValue(of({ data: { status: 'ok', modules } }));
    const { integration, discovery } = await crm.connect(org, 'hoops', { apiKey: ' key-1 ', history: '90' });
    // Connected with the key alone: the first sync is asked for straight away (python decides whether it may run now).
    expect(http.post).toHaveBeenCalledWith(expect.stringContaining('/sync/crm/run-for-source'), expect.anything(), expect.anything());
    // The key goes in Hoops' own header; the API's path is kept.
    expect(integrations.connectWithAuth).toHaveBeenLastCalledWith(
      org,
      'hoops',
      { authType: 'apiKeyBaseUrl', credentials: { apiKey: 'key-1', headerName: 'x-api-key' }, baseUrl: 'https://api.hoopscrm.com/rest/api' },
      { skipSync: true },
    );
    expect(discovery).toEqual(modules);
    expect(integration).toMatchObject({ id: 'hoops', connection: 'pull', status: 'connected' });

    // The Zapier-era source became the API source: Hoops' own mapping and schedule, and no webhook key.
    const stored = await sources.findOne({ organizationId: org, key: 'hoops' }).lean();
    expect(stored).toMatchObject({
      modules: ['deals', 'quotes', 'contacts', 'accounts'],
      statusMapping: { won: ['job'], lost: ['voided'] },
      metadata: { currency: 'AUD' },
    });
    expect(stored?.metadata.webhookReceived).toBeUndefined();
    expect(stored?.fieldMappings.deals).toMatchObject({ externalId: '_id', status: '_status', closeDate: '_closeDate', amount: 'total' });
    expect(stored?.sync).toMatchObject({ enabled: true, intervalMinutes: 1440, historyChoice: '90', window: { start: '19:00', end: '05:00', label: 'AEST' } });
    const ninetyDaysAgo = Date.now() - 90 * 86_400_000;
    expect(Math.abs(new Date(stored!.sync.historyFrom!).getTime() - ninetyDaysAgo)).toBeLessThan(60_000);
    // What the page shows: when it runs, and how far back the history reaches so far.
    expect(integration.source?.schedule).toMatchObject({ windowLabel: '7:00pm AEST' });
    expect(integration.source?.history).toEqual({ from: new Date(stored!.sync.historyFrom!), importedBackTo: null, complete: false });

    // A few nights in.
    await sources.updateOne(
      { _id: stored!._id },
      {
        $set: {
          'sync.cursor': new Date(),
          'sync.adapterState': { transactions: { skip: 120, at: '2026-10-20T09:00:00.000Z', oldest: '2026-09-02T00:00:00.000Z', done: false } },
        },
      },
    );
    expect((await crm.list(org))[1].source?.history).toMatchObject({ importedBackTo: new Date('2026-09-02T00:00:00.000Z'), complete: false });

    // A new key with the same history choice: the reading carries on where it was.
    await crm.connect(org, 'hoops', { apiKey: 'key-2', history: '90' });
    const same = await sources.findById(stored!._id).lean();
    expect(same?.sync.historyFrom).toEqual(stored?.sync.historyFrom);
    expect(same?.sync.adapterState?.transactions?.skip).toBe(120);

    // A different choice starts the reading over.
    await crm.connect(org, 'hoops', { apiKey: 'key-2', history: 'all', currency: 'nzd' });
    const restarted = await sources.findById(stored!._id).lean();
    expect(restarted?.sync).toMatchObject({ historyChoice: 'all', historyFrom: null });
    expect(restarted?.sync.adapterState).toBeUndefined();
    expect((restarted?.sync as Record<string, unknown>).cursor).toBeUndefined();
    expect(restarted?.metadata.currency).toBe('NZD');

    await crm.disconnect(org, 'hoops');
    expect((await crm.list(org))[1].status).toBe('not_connected');
  });
});
