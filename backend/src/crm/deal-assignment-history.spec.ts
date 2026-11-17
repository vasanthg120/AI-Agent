import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model, Types } from 'mongoose';
import { ASSIGNMENT_HISTORY_COLLECTION, DealsService } from './deals.service';
import { Deal, DealDocument, DealSchema } from './schemas/deal.schema';

// Against a real Mongo: every change of a deal's owner leaves a row — from,
// to, by whom, when, why — and a "change" to the same owner leaves none.
describe('deal assignment history (real Mongo)', () => {
  let connection: Connection;
  let dealModel: Model<DealDocument>;
  let deals: DealsService;
  const org = `jest-assign-history-${Date.now()}`;
  const [alice, bob, admin] = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()].map(String);

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(uri), MongooseModule.forFeature([{ name: Deal.name, schema: DealSchema }])],
    }).compile();
    connection = moduleRef.get(getConnectionToken());
    dealModel = moduleRef.get(getModelToken(Deal.name));
    deals = new DealsService(dealModel);
  });

  afterAll(async () => {
    await connection.collection('crm_deals').deleteMany({ organizationId: org });
    await connection.collection(ASSIGNMENT_HISTORY_COLLECTION).deleteMany({ organizationId: org });
    await connection.close();
  });

  const history = () => connection.collection(ASSIGNMENT_HISTORY_COLLECTION).find({ organizationId: org }).sort({ at: 1, _id: 1 }).toArray();

  it('records each change of owner, with who and why', async () => {
    const deal = await dealModel.create({ organizationId: org, name: 'Acme', dealStatus: 'open', monetaryValue: 100 });
    const id = deal._id.toString();

    const assigned = await deals.assignOwner(id, org, alice, undefined, { userId: admin, reason: 'New lead' });
    expect(assigned.ownerId).toBe(alice);
    await deals.assignOwner(id, org, alice, undefined, { userId: admin }); // same owner: nothing to record
    await deals.assignOwner(id, org, bob, undefined, { userId: admin, reason: 'Alice on leave' });

    expect((await history()).map((h) => [h.dealId, h.fromOwnerId, h.toOwnerId, h.assignedBy, h.reason])).toEqual([
      [id, null, alice, admin, 'New lead'],
      [id, alice, bob, admin, 'Alice on leave'],
    ]);
  });

  it('records a bulk assignment per deal that changed', async () => {
    const [a, b] = await dealModel.create([
      { organizationId: org, name: 'Beta', dealStatus: 'open', monetaryValue: 10, ownerId: bob },
      { organizationId: org, name: 'Gamma', dealStatus: 'open', monetaryValue: 20 },
    ]);
    const before = (await history()).length;
    const result = await deals.assignOwnerBulk([a._id.toString(), b._id.toString()], org, bob, undefined, { userId: admin, reason: 'Territory' });
    expect(result).toEqual({ requested: 2, assigned: 2 });
    const rows = (await history()).slice(before);
    // Beta already belonged to Bob: only Gamma changed.
    expect(rows.map((h) => [h.dealId, h.fromOwnerId, h.toOwnerId, h.reason])).toEqual([[b._id.toString(), null, bob, 'Territory']]);
  });
});
