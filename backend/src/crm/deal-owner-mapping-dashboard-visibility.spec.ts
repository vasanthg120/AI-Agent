import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { Deal, DealDocument, DealSchema } from './schemas/deal.schema';
import { DealOwnerMapping, DealOwnerMappingDocument, DealOwnerMappingSchema } from './schemas/deal-owner-mapping.schema';
import { DealOwnerMappingService } from './deal-owner-mapping.service';

// Regression coverage for "owner/admin connected the CRM, consultant's
// dashboard still shows zero deals/revenue" — traced this session to real,
// current production-shaped data (a real org's 353 synced deals all have
// externalOwnerRef/externalOwnerLabel but no ownerId, because no admin has
// yet used Settings -> Deal Assignment; crm_deal_owner_mappings had zero
// rows anywhere in the database). That is NOT a code defect — it is the
// correctly-designed, documented intermediate state (see deal.schema.ts's
// own comment on externalOwnerRef and deal-owner-mapping.service.ts's own
// header comment) between "CRM connected and synced" and "every deal
// attributed to a real HaiVE user." These tests prove the actual mechanism
// end to end, with synthetic ids only (never the real org/user ids found
// during the live-data trace), rather than asserting it from the schema's
// shape alone:
//   1. Before any mapping exists, a consultant's owner-scoped dashboard
//      query correctly returns nothing for deals carrying only a raw
//      external owner ref — not a bug, the intended "pending_mapping" state.
//   2. The SAME admin-performed mapping that Settings -> Deal Assignment's
//      upsertMapping already implements retroactively back-fills every
//      existing matching deal's ownerId, and after that the identical
//      owner-scoped query now correctly returns them — proving the fix
//      path (an admin action, not a code change) actually works.
//   3. Another organization's identically-shaped unmapped deals are never
//      affected by a different org's mapping, and its own consultant still
//      correctly sees nothing until ITS OWN admin maps it — cross-org
//      isolation holds throughout.
const PREFIX = `jest-deal-owner-visibility-${Date.now()}`;

describe('Deal-owner mapping and dashboard owner-scoped visibility (real Mongo)', () => {
  let connection: Connection;
  let dealModel: Model<DealDocument>;
  let mappingModel: Model<DealOwnerMappingDocument>;
  let service: DealOwnerMappingService;
  let seq = 0;
  let usersService: { findById: (id: string) => Promise<{ _id: string; name: string }>; findAll: (organizationId: string) => Promise<{ _id: string; name: string; active?: boolean }[]> };
  const eligibleUsersByOrg = new Map<string, { _id: string; name: string; active?: boolean }[]>();
  const registerUsers = (organizationId: string, ids: string[]) =>
    eligibleUsersByOrg.set(organizationId, ids.map((id) => ({ _id: id, name: `User ${id}`, active: true })));

  // Mirrors analytics-dashboard.service.ts's own dealMatch construction
  // exactly (organizationId + scope.level==='user' -> ownerId) — the actual
  // query a consultant's dashboard runs, not a paraphrase of it.
  const ownerScopedDealCount = (organizationId: string, ownerId: string) =>
    dealModel.countDocuments({ organizationId, ownerId });

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Deal.name, schema: DealSchema },
          { name: DealOwnerMapping.name, schema: DealOwnerMappingSchema },
        ]),
      ],
    }).compile();
    connection = moduleRef.get(getConnectionToken());
    dealModel = moduleRef.get(getModelToken(Deal.name));
    mappingModel = moduleRef.get(getModelToken(DealOwnerMapping.name));
    await mappingModel.init();

    // upsertMapping only touches dealModel/mappingModel/usersService for the
    // behavior under test — accountModel/quoteModel/dealsService are never
    // called by it, so trivial stubs are correct here, not a shortcut around
    // something that matters for these assertions. findAll backs
    // assertEligibleUsers' org-membership check — each test registers
    // exactly the synthetic users it needs via registerUsers below.
    usersService = {
      findById: async (id: string) => ({ _id: id, name: `User ${id}` }),
      findAll: async (organizationId: string) => eligibleUsersByOrg.get(organizationId) ?? [],
    };
    service = new DealOwnerMappingService(
      dealModel,
      mappingModel,
      null as never,
      null as never,
      usersService as never,
      null as never,
    );
  });

  afterAll(async () => {
    await dealModel.deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await mappingModel.deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await connection.collection('crm_quotes').deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await connection.close();
  });

  beforeEach(() => {
    seq += 1;
  });

  it('a synced deal with only a raw external owner ref correctly shows zero for the consultant it is not yet mapped to (the real, confirmed, pre-mapping state)', async () => {
    const org = `${PREFIX}-org-${seq}`;
    const consultantId = `consultant-${seq}`;
    await dealModel.create({
      organizationId: org,
      name: 'Unmapped deal',
      dealStatus: 'won',
      monetaryValue: 7000,
      expectedClosingDate: '2026-10-31',
      sourceProvider: 'prospectconnect',
      externalOwnerProvider: 'prospectconnect',
      externalOwnerRef: `ext-owner-${seq}`,
      externalOwnerLabel: 'Some Salesperson',
      // Deliberately no ownerId — exactly what the live sync produces
      // before any mapping exists.
    });

    expect(await ownerScopedDealCount(org, consultantId)).toBe(0);
  });

  it('the admin mapping that external owner to the consultant retroactively back-fills the existing deal, and the dashboard query now finds it', async () => {
    const org = `${PREFIX}-org-${seq}`;
    const consultantId = `consultant-${seq}`;
    const adminId = `admin-${seq}`;
    const externalOwnerRef = `ext-owner-${seq}`;

    const deal = await dealModel.create({
      organizationId: org,
      name: 'Deal awaiting mapping',
      dealStatus: 'won',
      monetaryValue: 9000,
      expectedClosingDate: '2026-10-31',
      sourceProvider: 'prospectconnect',
      externalOwnerProvider: 'prospectconnect',
      externalOwnerRef,
      externalOwnerLabel: 'Some Salesperson',
    });

    // Before mapping — the confirmed, legitimate zero state.
    expect(await ownerScopedDealCount(org, consultantId)).toBe(0);

    // The exact action Settings -> Deal Assignment performs.
    registerUsers(org, [consultantId]);
    const result = await service.upsertMapping(org, 'prospectconnect', externalOwnerRef, 'Some Salesperson', [consultantId], adminId);
    expect(result.dealCount).toBe(1);

    // After mapping — the same owner-scoped query a consultant's dashboard
    // runs now correctly finds the deal, with no other field touched.
    expect(await ownerScopedDealCount(org, consultantId)).toBe(1);
    const updated = await dealModel.findById(deal._id).exec();
    expect(updated?.ownerId).toBe(consultantId);
    expect(updated?.monetaryValue).toBe(9000);

    const mapping = await mappingModel.findOne({ organizationId: org, provider: 'prospectconnect', externalOwnerRef }).exec();
    expect(mapping?.ownerId).toBe(consultantId);
    expect(mapping?.mappedBy).toBe(adminId);
  });

  it('cross-organization isolation holds: mapping one org\'s external owner never affects another org\'s identically-labeled, still-unmapped deal', async () => {
    const orgA = `${PREFIX}-org-a-${seq}`;
    const orgB = `${PREFIX}-org-b-${seq}`;
    const consultantA = `consultant-a-${seq}`;
    const consultantB = `consultant-b-${seq}`;
    // Same provider + same raw external ref string in both orgs, on
    // purpose — the actual failure mode a cross-tenant bug would produce if
    // the mapping/back-fill query were ever org-unscoped.
    const sharedLookingExternalRef = `ext-owner-shared-${seq}`;

    await dealModel.create({
      organizationId: orgA,
      name: 'Org A deal',
      dealStatus: 'won',
      monetaryValue: 5000,
      expectedClosingDate: '2026-10-31',
      sourceProvider: 'prospectconnect',
      externalOwnerProvider: 'prospectconnect',
      externalOwnerRef: sharedLookingExternalRef,
    });
    await dealModel.create({
      organizationId: orgB,
      name: 'Org B deal',
      dealStatus: 'won',
      monetaryValue: 6000,
      expectedClosingDate: '2026-10-31',
      sourceProvider: 'prospectconnect',
      externalOwnerProvider: 'prospectconnect',
      externalOwnerRef: sharedLookingExternalRef,
    });

    registerUsers(orgA, [consultantA]);
    await service.upsertMapping(orgA, 'prospectconnect', sharedLookingExternalRef, undefined, [consultantA], `admin-a-${seq}`);

    expect(await ownerScopedDealCount(orgA, consultantA)).toBe(1);
    // Org B's deal must still be unmapped — org A's admin mapping their own
    // org's external ref must never reach org B's deal, even though the
    // provider and raw external ref string are identical.
    expect(await ownerScopedDealCount(orgB, consultantB)).toBe(0);
    const orgBDeal = await dealModel.findOne({ organizationId: orgB, externalOwnerRef: sharedLookingExternalRef }).exec();
    expect(orgBDeal?.ownerId).toBeUndefined();
    // And org A's consultant must never resolve to org B's deal either.
    expect(await ownerScopedDealCount(orgB, consultantA)).toBe(0);
  });
});
