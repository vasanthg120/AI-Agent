import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { cleanKeys, guessMappings, mapStatus, withDisplayName } from './canonical-mapping';
import { DataSourcesService } from './data-sources.service';
import { DataSource, DataSourceDocument, DataSourceSchema } from './schemas/data-source.schema';
import { WebhookSourcesService } from './webhook-sources.service';

const PREFIX = `jest-wh-${Date.now()}`;

describe('canonical mapping helpers', () => {
  it('guesses a mapping from a typical Zap payload', () => {
    const sample = withDisplayName(
      cleanKeys({
        ID: 42,
        'First Name': 'Ada',
        'Last Name': 'Lovelace',
        Email: 'ada@example.com',
        Mobile: '0400 000 000',
      }),
    );
    expect(guessMappings('contacts', sample)).toEqual({
      externalId: 'ID',
      name: '_display_name',
      email: 'Email',
      phone: 'Mobile',
    });
    expect(sample._display_name).toBe('Ada Lovelace');
  });

  it('maps statuses like the python sync (lost before won, contained values)', () => {
    const mapping = { won: ['completed', 'won'], lost: ['cancelled'] };
    expect(mapStatus('Completed', mapping)).toBe('won');
    expect(mapStatus('Job cancelled by customer', mapping)).toBe('lost');
    expect(mapStatus('Scheduled', mapping)).toBe('open');
    expect(mapStatus('', mapping)).toBe('open');
  });
});

// Against a real Mongo: pushed records land in their own source only, the key
// is the only way in, and a disconnected source stops accepting records.
describe('Webhook data sources (real Mongo)', () => {
  let connection: Connection;
  let sources: Model<DataSourceDocument>;
  let service: WebhookSourcesService;
  let seq = 0;
  let org: string;

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
    const dataSources = new DataSourcesService(sources, connection, {} as never, { sign: () => 'token' } as never, config);
    service = new WebhookSourcesService(sources, connection, dataSources, config);
  });

  beforeEach(() => {
    seq += 1;
    org = `${PREFIX}-org-${seq}`;
  });

  afterAll(async () => {
    for (const name of ['crm_deals', 'crm_contacts', 'crm_accounts', 'integration_credentials']) {
      await connection.collection(name).deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    }
    await sources.deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await connection.close();
  });

  it('stores pushed records under their own source, mapped from the first payload', async () => {
    const hoops = await service.create(org, {
      label: 'Hoops',
      terminology: { deal: 'Job', contact: 'Customer' },
    });
    const other = await service.create(org, { label: 'Other app' });
    expect(hoops.key).toMatch(/^hvk_/);
    expect(hoops.webhook.paths.contacts).toBe(`/data-source-webhooks/${hoops.id}/contacts`);

    const result = await service.ingest(hoops.id, 'contacts', hoops.key, {
      id: 'c1',
      first_name: 'Ada',
      last_name: 'L',
      email: 'ada@example.com',
    });
    expect(result).toMatchObject({ source: 'Hoops', stored: 1, skipped: 0 });
    await service.ingest(hoops.id, 'deals', hoops.key, [
      { id: 'j1', title: 'Roof repair', total: '$1,200', status: 'Completed' },
      { id: 'j2', title: 'Gutter clean', total: 300, status: 'Scheduled' },
    ]);
    await service.ingest(other.id, 'contacts', other.key, {
      id: 'c1',
      name: 'Someone else',
    });

    const source = await sources.findById(hoops.id).lean();
    expect(source?.status).toBe('active');
    expect(source?.fieldMappings.contacts).toMatchObject({
      externalId: 'id',
      name: '_display_name',
      email: 'email',
    });
    expect(source?.availableFields.contacts).toEqual(expect.arrayContaining(['id', 'first_name', 'email']));
    expect(source?.metadata.webhookReceived).toBe(3);

    const contacts = await connection.collection('crm_contacts').find({ organizationId: org, dataSourceId: hoops.id }).toArray();
    expect(contacts.map((c) => c.name)).toEqual(['Ada L']);
    const deals = await connection.collection('crm_deals').find({ organizationId: org, dataSourceId: hoops.id }).sort({ externalId: 1 }).toArray();
    expect(deals.map((d) => [d.name, d.monetaryValue, d.dealStatus])).toEqual([
      ['Roof repair', 1200, 'won'],
      ['Gutter clean', 300, 'open'],
    ]);
    // Same external id in another source is another record, never an overwrite.
    const otherContacts = await connection.collection('crm_contacts').find({ organizationId: org, dataSourceId: other.id }).toArray();
    expect(otherContacts.map((c) => c.name)).toEqual(['Someone else']);

    // Re-sending a record updates it in place.
    await service.ingest(hoops.id, 'contacts', hoops.key, {
      id: 'c1',
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@example.com',
    });
    expect(await connection.collection('crm_contacts').countDocuments({ organizationId: org, dataSourceId: hoops.id })).toBe(1);
  });

  it('refuses a wrong, rotated or missing key, and a disconnected source', async () => {
    const hoops = await service.create(org, { label: 'Hoops' });
    await expect(service.ingest(hoops.id, 'contacts', 'hvk_wrong', { id: 1 })).rejects.toThrow('Unknown webhook address or key.');
    await expect(service.ingest(hoops.id, 'contacts', undefined, { id: 1 })).rejects.toThrow('Unknown webhook address or key.');

    const rotated = await service.rotateKey(org, hoops.id);
    await expect(service.ingest(hoops.id, 'contacts', hoops.key, { id: 1 })).rejects.toThrow('Unknown webhook address or key.');
    await expect(service.ingest(hoops.id, 'contacts', rotated.key, { id: 1, name: 'X' })).resolves.toMatchObject({ stored: 1 });

    await expect(service.ingest(hoops.id, 'quotes', rotated.key, { id: 1 })).rejects.toThrow('Unknown record type');
    await service.disconnect(org, hoops.id);
    await expect(service.ingest(hoops.id, 'contacts', rotated.key, { id: 2 })).rejects.toThrow('Unknown webhook address or key.');
    // History stays.
    expect(await connection.collection('crm_contacts').countDocuments({ organizationId: org, dataSourceId: hoops.id })).toBe(1);
  });

  it('survives reconciliation (it has no integration credential) and skips records without an id', async () => {
    const app = await service.create(org, { label: 'Hoops' });
    await new DataSourcesService(sources, connection, {} as never, { sign: () => 'token' } as never, { get: () => undefined } as never).reconcile(org);
    expect((await sources.findById(app.id).lean())?.status).toBe('active');

    const result = await service.ingest(app.id, 'accounts', app.key, {
      company: 'No id Ltd',
    });
    expect(result).toMatchObject({ stored: 0, skipped: 1 });
    expect(result.problems[0]).toContain('ID field');
  });
});
