import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { Deal, DealDocument, DealSchema } from '../crm/schemas/deal.schema';
import { runWithDataSourceScope } from './data-source-context';
import { DataSourcesService } from './data-sources.service';
import { METRICS, crmMetricSupport } from './metric-catalog';
import { CRM_PROVIDERS, crmProviderForIntegration } from './provider-catalog';
import { DataSource, DataSourceDocument, DataSourceSchema } from './schemas/data-source.schema';

const PREFIX = `jest-ds-${Date.now()}`;

// The isolation guarantees, against a real Mongo: one CRM's records never
// appear when another source is selected, whatever kind of read a dashboard
// uses; nothing is merged unless "unified" is asked for.
describe('Data sources (real Mongo)', () => {
  let connection: Connection;
  let deals: Model<DealDocument>;
  let sources: Model<DataSourceDocument>;
  let service: DataSourcesService;
  let seq = 0;
  let org: string;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Deal.name, schema: DealSchema },
          { name: DataSource.name, schema: DataSourceSchema },
        ]),
      ],
    }).compile();
    deals = moduleRef.get(getModelToken(Deal.name));
    sources = moduleRef.get(getModelToken(DataSource.name));
    connection = moduleRef.get(getConnectionToken());
    await Promise.all([deals.init(), sources.init()]);
    service = new DataSourcesService(sources, connection, {} as never, { sign: () => 'token' } as never, { get: () => undefined } as never);
  });

  beforeEach(() => {
    seq += 1;
    org = `${PREFIX}-org-${seq}`;
  });

  afterAll(async () => {
    await deals.deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await sources.deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await connection.collection('integration_credentials').deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await connection.close();
  });

  const scope = (sourceIds: string[], nativeSourceId = 'native-src') => ({
    organizationId: org,
    mode: 'source' as const,
    sourceIds,
    nativeSourceId,
  });

  describe('query scoping', () => {
    beforeEach(async () => {
      await deals.create([
        {
          organizationId: org,
          name: 'A1',
          dataSourceId: 'src-a',
          dealStatus: 'won',
          monetaryValue: 100,
        },
        {
          organizationId: org,
          name: 'A2',
          dataSourceId: 'src-a',
          dealStatus: 'open',
          monetaryValue: 50,
        },
        {
          organizationId: org,
          name: 'B1',
          dataSourceId: 'src-b',
          dealStatus: 'won',
          monetaryValue: 999,
        },
      ]);
      // Created outside any request — no source tag.
      await deals.collection.insertOne({
        organizationId: org,
        name: 'N1',
        dealStatus: 'open',
        monetaryValue: 7,
      });
    });

    it('limits find, count, distinct and aggregate to the selected source', async () => {
      await runWithDataSourceScope(scope(['src-a']), async () => {
        expect((await deals.find({ organizationId: org }).exec()).map((d) => d.name).sort()).toEqual(['A1', 'A2']);
        expect(await deals.countDocuments({ organizationId: org }).exec()).toBe(2);
        expect((await deals.distinct('name', { organizationId: org }).exec()).sort()).toEqual(['A1', 'A2']);
        const [won] = await deals
          .aggregate<{ total: number }>([{ $match: { organizationId: org, dealStatus: 'won' } }, { $group: { _id: null, total: { $sum: '$monetaryValue' } } }])
          .exec();
        expect(won.total).toBe(100);
      });
    });

    it('keeps a query’s own $or intact', async () => {
      await runWithDataSourceScope(scope(['src-b']), async () => {
        const found = await deals.find({ organizationId: org, $or: [{ name: 'A1' }, { name: 'B1' }] }).exec();
        expect(found.map((d) => d.name)).toEqual(['B1']);
      });
    });

    it('treats untagged records as the HaiVE workspace’s', async () => {
      await runWithDataSourceScope(scope(['native-src']), async () => {
        expect((await deals.find({ organizationId: org }).exec()).map((d) => d.name)).toEqual(['N1']);
      });
    });

    it('unified reads every selected source', async () => {
      await runWithDataSourceScope(scope(['src-a', 'src-b']), async () => {
        expect(await deals.countDocuments({ organizationId: org }).exec()).toBe(3);
      });
    });

    it('leaves _id lookups, other organizations and explicit source filters alone', async () => {
      const b1 = await deals.findOne({ organizationId: org, name: 'B1' }).exec();
      await runWithDataSourceScope(scope(['src-a']), async () => {
        expect(await deals.findById(b1!._id).exec()).not.toBeNull();
        expect(await deals.countDocuments({ organizationId: org, dataSourceId: 'src-b' }).exec()).toBe(1);
        expect(await deals.countDocuments({ organizationId: `${org}-other` }).exec()).toBe(0);
      });
    });

    it('stamps records created during a request with the HaiVE workspace source', async () => {
      const created = await runWithDataSourceScope(scope(['src-a'], 'native-src'), () => deals.create({ organizationId: org, name: 'New' }));
      expect(created.dataSourceId).toBe('native-src');
    });

    it('does nothing outside a request', async () => {
      expect(await deals.countDocuments({ organizationId: org }).exec()).toBe(4);
    });
  });

  describe('sources', () => {
    it('creates one source per connected CRM, defaults to it, and backfills legacy records', async () => {
      await connection.collection('integration_credentials').insertOne({ organizationId: org, provider: 'prospectconnect' });
      await deals.collection.insertMany([
        { organizationId: org, name: 'synced', externalId: 'x1' },
        { organizationId: org, name: 'native' },
      ]);
      await service.reconcile(org);
      await service.backfill(org);

      const all = await sources.find({ organizationId: org }).exec();
      expect(all.map((s) => s.key).sort()).toEqual(['haive', 'prospectconnect']);
      const pc = all.find((s) => s.key === 'prospectconnect')!;
      const native = all.find((s) => s.key === 'haive')!;
      expect(pc.isDefault).toBe(true);
      expect(pc.label).toBe('Customized Haive CRM');
      expect((await deals.findOne({ organizationId: org, name: 'synced' }).exec())!.dataSourceId).toBe(pc._id.toString());
      expect((await deals.findOne({ organizationId: org, name: 'native' }).exec())!.dataSourceId).toBe(native._id.toString());
    });

    it('never merges by default; unified only when asked; a foreign id falls back to the default', async () => {
      await connection.collection('integration_credentials').insertMany([
        { organizationId: org, provider: 'prospectconnect' },
        { organizationId: org, provider: 'hubspot' },
      ]);
      await service.reconcile(org);
      const all = await sources.find({ organizationId: org }).exec();
      const hubspot = all.find((s) => s.key === 'hubspot')!;

      const byDefault = await service.resolveScope(org, undefined);
      expect(byDefault.mode).toBe('default');
      expect(byDefault.sourceIds).toHaveLength(1);

      const unified = await service.resolveScope(org, 'unified');
      expect(unified.sourceIds).toHaveLength(3);

      const chosen = await service.resolveScope(org, hubspot._id.toString());
      expect(chosen.sourceIds).toEqual([hubspot._id.toString()]);

      const foreign = await service.resolveScope(org, '64b000000000000000000000');
      expect(foreign.mode).toBe('default');
    });

    it('marks a removed CRM disconnected, keeps its history, and moves the default', async () => {
      await connection.collection('integration_credentials').insertOne({ organizationId: org, provider: 'hubspot' });
      await service.reconcile(org);
      await connection.collection('integration_credentials').deleteMany({ organizationId: org });
      await service.reconcile(org);
      const all = await sources.find({ organizationId: org }).exec();
      const hubspot = all.find((s) => s.key === 'hubspot')!;
      expect(hubspot.status).toBe('disconnected');
      expect(hubspot.isDefault).toBe(false);
      expect(all.find((s) => s.key === 'haive')!.isDefault).toBe(true);
      // Unified never includes a disconnected source.
      expect((await service.resolveScope(org, 'unified')).sourceIds).not.toContain(hubspot._id.toString());
    });

    it('rejects field mappings that are not HaiVE fields or not valid paths', async () => {
      await connection.collection('integration_credentials').insertOne({ organizationId: org, provider: 'hubspot' });
      await service.reconcile(org);
      const hubspot = (await sources.findOne({ organizationId: org, key: 'hubspot' }).exec())!;
      await expect(
        service.update(org, hubspot._id.toString(), {
          fieldMappings: { deals: { bogus: 'x' } },
        }),
      ).rejects.toThrow(/not a deals field/);
      await expect(
        service.update(org, hubspot._id.toString(), {
          fieldMappings: { deals: { amount: 'a;drop' } },
        }),
      ).rejects.toThrow(/valid field name/);
      const updated = await service.update(org, hubspot._id.toString(), {
        fieldMappings: { deals: { amount: 'properties.hs_amount' } },
      });
      expect(updated!.fieldMappings.deals).toEqual({
        amount: 'properties.hs_amount',
      });
    });
  });
});

describe('metric support', () => {
  const metric = (id: string) => METRICS.find((m) => m.id === id)!;
  const hubspot = CRM_PROVIDERS.hubspot;

  it('a CRM without quotes cannot show quote metrics — with the reason', () => {
    const result = crmMetricSupport(metric('quotes'), {
      modules: hubspot.modules,
      fieldMappings: hubspot.fieldMappings,
      statusMapping: hubspot.statusMapping,
      native: false,
    });
    expect(result).toEqual({
      supported: false,
      reason: 'This CRM has no quotes.',
    });
  });

  it('an unmapped amount means no pipeline or revenue', () => {
    const noAmount = { deals: { ...hubspot.fieldMappings.deals } };
    delete noAmount.deals.amount;
    const input = {
      modules: hubspot.modules,
      fieldMappings: noAmount,
      statusMapping: hubspot.statusMapping,
      native: false,
    };
    expect(crmMetricSupport(metric('activePipeline'), input).supported).toBe(false);
    expect(crmMetricSupport(metric('totalDeals'), input).supported).toBe(true);
  });

  it('the HaiVE workspace supports every CRM metric', () => {
    const native = CRM_PROVIDERS.haive_native;
    for (const m of METRICS.filter((x) => x.kind === 'crm' && x.id !== 'vendorProfitability')) {
      expect(
        crmMetricSupport(m, {
          modules: native.modules,
          fieldMappings: {},
          statusMapping: native.statusMapping,
          native: true,
        }).supported,
      ).toBe(true);
    }
  });

  it('recognises CRMs by their integration name', () => {
    expect(crmProviderForIntegration('crm')?.id).toBe('prospectconnect');
    expect(crmProviderForIntegration('HubSpot')?.id).toBe('hubspot');
    expect(crmProviderForIntegration('stripe')).toBeNull();
  });
});
