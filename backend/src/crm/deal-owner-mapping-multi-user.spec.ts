import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { Connection, Model } from 'mongoose';
import { Deal, DealDocument, DealSchema } from './schemas/deal.schema';
import { DealOwnerMapping, DealOwnerMappingDocument, DealOwnerMappingSchema } from './schemas/deal-owner-mapping.schema';
import { DealOwnerMappingService } from './deal-owner-mapping.service';
import { DealsService } from './deals.service';

// Regression coverage for multi-user CRM owner linking (see
// deal-owner-mapping.service.ts's own upsertMapping comment for the full
// design). Linking multiple users establishes an ASSOCIATION, never
// ownership: a deal always has at most one authoritative ownerId, and
// linking a second/third user to an already-mapped salesperson must never
// change, clear, or redistribute any existing deal's ownerId. Synthetic
// org/user/deal ids only — never the real org/user ids found during the
// earlier dashboard-visibility investigation this session, and no write
// against real data at any point.
const PREFIX = `jest-multi-user-mapping-${Date.now()}`;

describe('DealOwnerMappingService — multi-user CRM owner linking', () => {
  let connection: Connection;
  let dealModel: Model<DealDocument>;
  let mappingModel: Model<DealOwnerMappingDocument>;
  let service: DealOwnerMappingService;
  let dealsService: DealsService;
  let seq = 0;
  const eligibleUsersByOrg = new Map<string, { _id: string; name: string; active?: boolean }[]>();
  const registerUsers = (organizationId: string, ids: string[]) =>
    eligibleUsersByOrg.set(organizationId, ids.map((id) => ({ _id: id, name: `User ${id}`, active: true })));

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

    const usersService = {
      findById: async (id: string) => ({ _id: id, name: `User ${id}` }),
      findAll: async (organizationId: string) => eligibleUsersByOrg.get(organizationId) ?? [],
    };
    service = new DealOwnerMappingService(dealModel, mappingModel, null as never, null as never, usersService as never, null as never);
    dealsService = new DealsService(dealModel);
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

  it('item 1: an exactly-one-element ownerIds array behaves identically to the legacy single-owner mapping', async () => {
    const org = `${PREFIX}-org-${seq}`;
    const userA = `user-a-${seq}`;
    const ref = `ext-${seq}`;
    registerUsers(org, [userA]);
    await dealModel.create({ organizationId: org, name: 'D1', dealStatus: 'open', monetaryValue: 100, sourceProvider: 'prospectconnect', externalOwnerProvider: 'prospectconnect', externalOwnerRef: ref });

    const result = await service.upsertMapping(org, 'prospectconnect', ref, 'Label', [userA], `admin-${seq}`);

    expect(result.mapping?.ownerId).toBe(userA);
    expect(result.dealCount).toBe(1);
    const deal = await dealModel.findOne({ organizationId: org, externalOwnerRef: ref }).exec();
    expect(deal?.ownerId).toBe(userA);
  });

  it('item 2: one external salesperson can be linked to multiple users, recorded as an association, not applied to any deal', async () => {
    const org = `${PREFIX}-org-${seq}`;
    const userA = `user-a-${seq}`;
    const userB = `user-b-${seq}`;
    const ref = `ext-${seq}`;
    registerUsers(org, [userA, userB]);
    await dealModel.create({ organizationId: org, name: 'D1', dealStatus: 'open', monetaryValue: 100, sourceProvider: 'prospectconnect', externalOwnerProvider: 'prospectconnect', externalOwnerRef: ref });

    const result = await service.upsertMapping(org, 'prospectconnect', ref, 'Label', [userA, userB], `admin-${seq}`);

    expect(result.mapping?.ownerId).toBeUndefined();
    expect(result.mapping?.linkedUserIds.sort()).toEqual([userA, userB].sort());
    expect(result.dealCount).toBe(0);
    const deal = await dealModel.findOne({ organizationId: org, externalOwnerRef: ref }).exec();
    expect(deal?.ownerId).toBeUndefined();
  });

  it('item 3: duplicate user ids in the request are deduped idempotently, not rejected or double-stored', async () => {
    const org = `${PREFIX}-org-${seq}`;
    const userA = `user-a-${seq}`;
    const ref = `ext-${seq}`;
    registerUsers(org, [userA]);

    const result = await service.upsertMapping(org, 'prospectconnect', ref, 'Label', [userA, userA], `admin-${seq}`);

    expect(result.mapping?.linkedUserIds).toEqual([userA]);
    expect(result.mapping?.ownerId).toBe(userA); // one real user -> still unambiguous
  });

  it('item 4: historical deal owners are unchanged when a second user is linked to an already-mapped salesperson', async () => {
    const org = `${PREFIX}-org-${seq}`;
    const userA = `user-a-${seq}`;
    const userB = `user-b-${seq}`;
    const ref = `ext-${seq}`;

    registerUsers(org, [userA]);
    const deal = await dealModel.create({ organizationId: org, name: 'D1', dealStatus: 'open', monetaryValue: 100, sourceProvider: 'prospectconnect', externalOwnerProvider: 'prospectconnect', externalOwnerRef: ref });
    await service.upsertMapping(org, 'prospectconnect', ref, 'Label', [userA], `admin-${seq}`);
    expect((await dealModel.findById(deal._id).exec())?.ownerId).toBe(userA);

    // Now an admin links a second user — must NOT redistribute or clear the
    // existing, already-correct assignment.
    registerUsers(org, [userA, userB]);
    const result = await service.upsertMapping(org, 'prospectconnect', ref, 'Label', [userA, userB], `admin-${seq}`);

    expect(result.dealCount).toBe(0);
    const unchanged = await dealModel.findById(deal._id).exec();
    expect(unchanged?.ownerId).toBe(userA);
  });

  it('item 5: an unowned deal under an ambiguous mapping can still be explicitly assigned, and is then protected', async () => {
    const org = `${PREFIX}-org-${seq}`;
    const userA = `user-a-${seq}`;
    const userB = `user-b-${seq}`;
    const ref = `ext-${seq}`;
    registerUsers(org, [userA, userB]);
    const deal = await dealModel.create({ organizationId: org, name: 'D1', dealStatus: 'open', monetaryValue: 100, sourceProvider: 'prospectconnect', externalOwnerProvider: 'prospectconnect', externalOwnerRef: ref });
    await service.upsertMapping(org, 'prospectconnect', ref, 'Label', [userA, userB], `admin-${seq}`);
    expect((await dealModel.findById(deal._id).exec())?.ownerId).toBeUndefined();

    const assigned = await dealsService.assignOwner(deal._id.toString(), org, userB);

    expect(assigned.ownerId).toBe(userB);
    expect(assigned.ownerAssignedManually).toBe(true);
  });

  it('item 9/10: a deal never ends up with more than one owner value, and per-owner counts never double-count it', async () => {
    const org = `${PREFIX}-org-${seq}`;
    const userA = `user-a-${seq}`;
    const userB = `user-b-${seq}`;
    const ref = `ext-${seq}`;
    registerUsers(org, [userA, userB]);
    await dealModel.create({ organizationId: org, name: 'D1', dealStatus: 'won', monetaryValue: 500, sourceProvider: 'prospectconnect', externalOwnerProvider: 'prospectconnect', externalOwnerRef: ref });
    await service.upsertMapping(org, 'prospectconnect', ref, 'Label', [userA, userB], `admin-${seq}`);

    // ownerId is a single string field by schema, not an array — but prove
    // the actual runtime consequence: neither linked user's individual
    // dashboard count includes this still-ambiguous deal, so its revenue is
    // attributed to nobody (never both) until explicitly assigned.
    const countForA = await dealModel.countDocuments({ organizationId: org, ownerId: userA });
    const countForB = await dealModel.countDocuments({ organizationId: org, ownerId: userB });
    expect(countForA).toBe(0);
    expect(countForB).toBe(0);
  });

  it('item 11: linking a user from a different organization is rejected, and nothing is written', async () => {
    const orgA = `${PREFIX}-org-a-${seq}`;
    const orgB = `${PREFIX}-org-b-${seq}`;
    const userInOrgB = `user-b-${seq}`;
    registerUsers(orgA, []); // nobody eligible in org A
    registerUsers(orgB, [userInOrgB]);

    await expect(service.upsertMapping(orgA, 'prospectconnect', `ext-${seq}`, 'Label', [userInOrgB], `admin-${seq}`)).rejects.toThrow(
      BadRequestException,
    );
    const mapping = await mappingModel.findOne({ organizationId: orgA }).exec();
    expect(mapping).toBeNull();
  });

  it('item 14: an unambiguous mapping still assigns linked quotes, an ambiguous one never touches them', async () => {
    const orgUnambiguous = `${PREFIX}-org-quote-1-${seq}`;
    const orgAmbiguous = `${PREFIX}-org-quote-2-${seq}`;
    const userA = `user-a-${seq}`;
    const userB = `user-b-${seq}`;
    const ref = `ext-${seq}`;
    await connection.collection('crm_quotes').insertMany([
      { organizationId: orgUnambiguous, sourceProvider: 'prospectconnect', quoteOwner: ref, quoteName: 'Q1' },
      { organizationId: orgAmbiguous, sourceProvider: 'prospectconnect', quoteOwner: ref, quoteName: 'Q2' },
    ]);

    registerUsers(orgUnambiguous, [userA]);
    await service.upsertMapping(orgUnambiguous, 'prospectconnect', ref, 'Label', [userA], `admin-${seq}`);
    const quote1 = await connection.collection('crm_quotes').findOne({ organizationId: orgUnambiguous, quoteOwner: ref });
    expect(quote1?.ownerUserId).toBe(userA);

    registerUsers(orgAmbiguous, [userA, userB]);
    await service.upsertMapping(orgAmbiguous, 'prospectconnect', ref, 'Label', [userA, userB], `admin-${seq}`);
    const quote2 = await connection.collection('crm_quotes').findOne({ organizationId: orgAmbiguous, quoteOwner: ref });
    expect(quote2?.ownerUserId).toBeUndefined();
  });

  it('item 13: manual single and bulk assignment still work exactly as before, now also marking the deal manually-assigned', async () => {
    const org = `${PREFIX}-org-${seq}`;
    const userA = `user-a-${seq}`;
    const d1 = await dealModel.create({ organizationId: org, name: 'D1', dealStatus: 'open', monetaryValue: 10 });
    const d2 = await dealModel.create({ organizationId: org, name: 'D2', dealStatus: 'open', monetaryValue: 20 });

    const single = await dealsService.assignOwner(d1._id.toString(), org, userA);
    expect(single.ownerId).toBe(userA);
    expect(single.ownerAssignedManually).toBe(true);

    const bulk = await dealsService.assignOwnerBulk([d2._id.toString()], org, userA);
    expect(bulk.assigned).toBe(1);
    const updatedD2 = await dealModel.findById(d2._id).exec();
    expect(updatedD2?.ownerId).toBe(userA);
    expect(updatedD2?.ownerAssignedManually).toBe(true);

    // Unassigning clears both fields, deliberately opting back into
    // automatic resolution.
    const unassigned = await dealsService.assignOwner(d1._id.toString(), org, null);
    expect(unassigned.ownerId).toBeUndefined();
    expect(unassigned.ownerAssignedManually).toBeUndefined();
  });

  it('item 15: removing a user down to exactly one re-enables single-user behavior deterministically — assigns to the specific remaining user, never randomly', async () => {
    const org = `${PREFIX}-org-${seq}`;
    const userA = `user-a-${seq}`;
    const userB = `user-b-${seq}`;
    const ref = `ext-${seq}`;
    registerUsers(org, [userA, userB]);
    const deal = await dealModel.create({ organizationId: org, name: 'D1', dealStatus: 'open', monetaryValue: 100, sourceProvider: 'prospectconnect', externalOwnerProvider: 'prospectconnect', externalOwnerRef: ref });
    await service.upsertMapping(org, 'prospectconnect', ref, 'Label', [userA, userB], `admin-${seq}`);
    expect((await dealModel.findById(deal._id).exec())?.ownerId).toBeUndefined();

    // Admin removes userB, leaving exactly userA linked.
    const result = await service.upsertMapping(org, 'prospectconnect', ref, 'Label', [userA], `admin-${seq}`);

    expect(result.mapping?.ownerId).toBe(userA);
    const resolved = await dealModel.findById(deal._id).exec();
    expect(resolved?.ownerId).toBe(userA);
  });

  it('removing all links (deleting the mapping) never touches deals it already applied to', async () => {
    const org = `${PREFIX}-org-${seq}`;
    const userA = `user-a-${seq}`;
    const ref = `ext-${seq}`;
    registerUsers(org, [userA]);
    const deal = await dealModel.create({ organizationId: org, name: 'D1', dealStatus: 'open', monetaryValue: 100, sourceProvider: 'prospectconnect', externalOwnerProvider: 'prospectconnect', externalOwnerRef: ref });
    const { mapping } = await service.upsertMapping(org, 'prospectconnect', ref, 'Label', [userA], `admin-${seq}`);

    await service.deleteMapping(org, mapping!.id);

    const stillAssigned = await dealModel.findById(deal._id).exec();
    expect(stillAssigned?.ownerId).toBe(userA);
  });
});
