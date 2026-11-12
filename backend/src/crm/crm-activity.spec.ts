import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model, Types } from 'mongoose';
import { CrmActivityService, middayOf } from './crm-activity.service';
import { DealOwnerMappingService } from './deal-owner-mapping.service';
import { DealsService } from './deals.service';
import { CrmActivity, CrmActivityDocument, CrmActivitySchema } from './schemas/crm-activity.schema';
import { Deal, DealDocument, DealSchema } from './schemas/deal.schema';
import { DealOwnerMapping, DealOwnerMappingDocument, DealOwnerMappingSchema } from './schemas/deal-owner-mapping.schema';

const PREFIX = `jest-crm-activity-${Date.now()}`;

// Against a real Mongo: the CRM activity log's backfill and HaiVE's own writes,
// and Settings → Deal Assignment crediting quotation salespeople (shared CRM
// accounts kept apart, deals owned through their quotations).
describe('CRM activity log and quotation salespeople (real Mongo)', () => {
  let connection: Connection;
  let activityModel: Model<CrmActivityDocument>;
  let dealModel: Model<DealDocument>;
  let mappingModel: Model<DealOwnerMappingDocument>;
  let activity: CrmActivityService;
  let deals: DealsService;
  let mappings: DealOwnerMappingService;
  let seq = 0;
  let org: string;
  const usersByOrg = new Map<string, { _id: string; name: string; active: boolean }[]>();

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: CrmActivity.name, schema: CrmActivitySchema },
          { name: Deal.name, schema: DealSchema },
          { name: DealOwnerMapping.name, schema: DealOwnerMappingSchema },
        ]),
      ],
    }).compile();
    connection = moduleRef.get(getConnectionToken());
    activityModel = moduleRef.get(getModelToken(CrmActivity.name));
    dealModel = moduleRef.get(getModelToken(Deal.name));
    mappingModel = moduleRef.get(getModelToken(DealOwnerMapping.name));
    await activityModel.init();
    await mappingModel.init();
    activity = new CrmActivityService(activityModel, connection);
    deals = new DealsService(dealModel, activity);
    const users = { findAll: async (organizationId: string) => usersByOrg.get(organizationId) ?? [] };
    mappings = new DealOwnerMappingService(dealModel, mappingModel, null as never, null as never, users as never, null as never);
  });

  afterAll(async () => {
    for (const name of ['crm_activities', 'crm_deals', 'crm_quotes', 'crm_deal_owner_mappings', 'crm_data_sources']) {
      await connection.collection(name).deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    }
    await connection.close();
  });

  beforeEach(() => {
    seq += 1;
    org = `${PREFIX}-org-${seq}`;
  });

  const logOf = async () =>
    (await activityModel.find({ organizationId: org }).sort({ occurredAt: 1, kind: 1 }).lean().exec()).map((r) => [
      r.entity,
      r.kind,
      r.ref,
      r.occurredAtBasis,
      r.occurredAt.toISOString(),
    ]);

  it('backfill: only the history the CRMs honestly give — and a second run adds nothing', async () => {
    const hoops = new Types.ObjectId();
    const pantheras = new Types.ObjectId();
    await connection.collection('crm_data_sources').insertMany([
      { _id: hoops, organizationId: org, key: 'hoops', provider: 'hoops', fieldMappings: { deals: { createdAt: 'createdAt' }, quotes: { createdAt: 'createdAt' } } },
      { _id: pantheras, organizationId: org, key: 'prospectconnect', provider: 'prospectconnect', fieldMappings: { quotes: { createdAt: 'date_created' } } },
    ]);
    const deal = (name: string, source: Types.ObjectId, more: Record<string, unknown>) => ({
      organizationId: org,
      name,
      dataSourceId: source.toString(),
      sourceProvider: source === hoops ? 'hoops' : 'prospectconnect',
      externalId: `ext-${name}`,
      monetaryValue: 1000,
      ...more,
    });
    await connection.collection('crm_deals').insertMany([
      // Hoops sends its creation date: created logged; won on its closing date (no closedAt).
      deal('H-won', hoops, { dealStatus: 'won', expectedClosingDate: '2026-10-30', createdAt: new Date('2026-10-01T03:00:00Z') }),
      // Pantheras does not: no creation logged; lost when closedAt recorded it.
      deal('P-lost', pantheras, { dealStatus: 'lost', expectedClosingDate: '2026-10-20', closedAt: new Date('2026-10-21T09:15:00Z'), createdAt: new Date('2026-10-05T00:00:00Z') }),
      deal('P-open', pantheras, { dealStatus: 'open', createdAt: new Date('2026-10-05T00:00:00Z') }),
    ]);
    await connection.collection('crm_quotes').insertMany([
      { organizationId: org, dataSourceId: pantheras.toString(), externalId: 'q-1', quoteNumber: '118', quoteStatus: 'published', clientApprovalStatus: 'approved', quoteAmount: 500, createdAt: new Date('2026-10-02T05:00:00Z') },
      { organizationId: org, dataSourceId: pantheras.toString(), externalId: 'q-2', quoteNumber: '119', quoteStatus: 'draft', clientApprovalStatus: 'awaiting_response', quoteAmount: 700, createdAt: new Date('2026-10-03T05:00:00Z') },
    ]);

    const written = await activity.backfill(org, 'Asia/Kolkata');
    expect(written).toBe(6);
    expect(await logOf()).toEqual([
      ['deal', 'created', 'H-won', 'crm', '2026-10-01T03:00:00.000Z'],
      ['quote', 'created', '118', 'crm', '2026-10-02T05:00:00.000Z'],
      ['quote', 'sent', '118', 'assumed', '2026-10-02T05:00:00.000Z'],
      ['quote', 'created', '119', 'crm', '2026-10-03T05:00:00.000Z'],
      ['deal', 'lost', 'P-lost', 'detected', '2026-10-21T09:15:00.000Z'],
      // Noon in India on the closing date.
      ['deal', 'won', 'H-won', 'closing_date', middayOf('Asia/Kolkata', '2026-10-30').toISOString()],
    ].sort((a, b) => String(a[4]).localeCompare(String(b[4])) || String(a[1]).localeCompare(String(b[1]))));

    await activity.backfill(org, 'Asia/Kolkata');
    expect(await activityModel.countDocuments({ organizationId: org })).toBe(6);
    // The acceptance of quote 118 has no known date and is not invented.
    expect(await activityModel.countDocuments({ organizationId: org, kind: 'accepted' })).toBe(0);
  });

  it('a deal created and closed in HaiVE is credited to the person signed in', async () => {
    const deal = await deals.create(org, { name: 'Caps', dealStatus: 'open', monetaryValue: 2500 } as never, undefined, 'user-1');
    await deals.update(deal._id.toString(), org, { dealStatus: 'won' } as never, undefined, 'user-2');
    // Saving the same status again is not a second win.
    await deals.update(deal._id.toString(), org, { dealStatus: 'won' } as never, undefined, 'user-2');
    await new Promise((r) => setTimeout(r, 300));
    const rows = await activityModel.find({ organizationId: org }).sort({ occurredAt: 1 }).lean().exec();
    expect(rows.map((r) => [r.kind, r.fromStatus, r.toStatus, r.actorUserId, r.origin, r.occurredAtBasis, r.value])).toEqual([
      ['created', undefined, 'open', 'user-1', 'haive', 'haive', 2500],
      ['won', 'open', 'won', 'user-2', 'haive', 'haive', 2500],
    ]);
  });

  it('Deal Assignment lists the quotation salespeople, a shared account credits nobody, and a person owns their quotations’ deals', async () => {
    usersByOrg.set(org, [{ _id: 'user-k', name: 'Kshitij Hedge', active: true }]);
    const dealId = (await dealModel.create({ organizationId: org, name: 'Polos', dealStatus: 'open', monetaryValue: 1, sourceProvider: 'hoops' }))._id.toString();
    const sharedDealId = (await dealModel.create({ organizationId: org, name: 'Enquiry deal', dealStatus: 'open', monetaryValue: 1, sourceProvider: 'hoops' }))._id.toString();
    const manualDealId = (
      await dealModel.create({ organizationId: org, name: 'Hand-assigned', dealStatus: 'open', monetaryValue: 1, sourceProvider: 'hoops', ownerId: 'user-z', ownerAssignedManually: true })
    )._id.toString();
    const q = (ref: string, label: string, deal: string, created: string) => ({
      organizationId: org,
      sourceProvider: 'hoops',
      quoteOwner: ref,
      quoteOwnerLabel: label,
      dealId: deal,
      quoteStatus: 'sent',
      createdAt: new Date(created),
    });
    await connection.collection('crm_quotes').insertMany([
      q('kshitij', 'Kshitij Hedge', dealId, '2026-10-01T00:00:00Z'),
      // The deal's LATEST quotation decides: an earlier one by the shared account doesn't.
      q('shared-1', 'Fully Promoted Surryhills', dealId, '2026-09-01T00:00:00Z'),
      q('shared-1', 'Fully Promoted Surryhills', sharedDealId, '2026-10-02T00:00:00Z'),
      q('kshitij', 'Kshitij Hedge', manualDealId, '2026-10-03T00:00:00Z'),
    ]);

    const listed = await mappings.listExternalOwners(org);
    // Equal counts: by name.
    expect(listed.map((r) => [r.externalOwnerLabel, r.quoteCount, r.dealCount, r.mapping])).toEqual([
      ['Fully Promoted Surryhills', 2, 0, null],
      ['Kshitij Hedge', 2, 0, null],
    ]);
    expect(listed[1].suggestedOwnerId).toBe('user-k');

    const linked = await mappings.upsertMapping(org, 'hoops', 'kshitij', 'Kshitij Hedge', ['user-k'], 'admin');
    expect(linked).toMatchObject({ dealCount: 1, quoteCount: 2, mapping: { ownerId: 'user-k', shared: false } });
    expect(await dealModel.findById(dealId).lean()).toMatchObject({ ownerId: 'user-k', ownerFromQuoteOwnerRef: 'kshitij' });
    // A deal assigned by hand keeps its owner.
    expect(await dealModel.findById(manualDealId).lean()).toMatchObject({ ownerId: 'user-z' });
    expect(await connection.collection('crm_quotes').countDocuments({ organizationId: org, ownerUserId: 'user-k' })).toBe(2);

    const shared = await mappings.markShared(org, 'hoops', 'shared-1', 'Fully Promoted Surryhills', 'admin');
    expect(shared).toMatchObject({ quoteCount: 2, mapping: { shared: true, linkedUserIds: [] } });
    expect((await dealModel.findById(sharedDealId).lean())?.ownerId).toBeUndefined();

    // Marking Kshitij shared afterwards takes back what the link gave — the quotations and the deal it owned through them.
    await mappings.markShared(org, 'hoops', 'kshitij', 'Kshitij Hedge', 'admin');
    expect(await dealModel.findById(dealId).lean()).not.toHaveProperty('ownerId');
    expect(await connection.collection('crm_quotes').countDocuments({ organizationId: org, ownerUserId: 'user-k' })).toBe(0);
    expect(await dealModel.findById(manualDealId).lean()).toMatchObject({ ownerId: 'user-z' });
    expect((await mappings.listExternalOwners(org)).map((r) => [r.externalOwnerLabel, r.mapping?.shared])).toEqual([
      ['Fully Promoted Surryhills', true],
      ['Kshitij Hedge', true],
    ]);
  });
});
