import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { buildDealMatchStage } from './deal-filter.util';
import { DealPerformanceDashboardService } from './deal-performance-dashboard.service';
import { hoopsSalespersonId } from './hoops-salespeople';
import { Deal, DealDocument, DealSchema } from './schemas/deal.schema';

const PREFIX = `jest-hoops-people-${Date.now()}`;

describe('a deal list filtered by salesperson', () => {
  it('HaiVE users: exactly as before', () => {
    expect(buildDealMatchStage('org', { ownerId: ['u1', 'u2'] } as never)).toEqual({ organizationId: 'org', ownerId: { $in: ['u1', 'u2'] } });
  });

  it('a Hoops salesperson: their Hoops sales that no HaiVE user owns', () => {
    expect(buildDealMatchStage('org', { ownerId: ['u1', 'hoops:h-7'] } as never)).toEqual({
      organizationId: 'org',
      $or: [{ ownerId: { $in: ['u1'] } }, { sourceProvider: 'hoops', ownerId: { $in: [null] }, externalOwnerRef: { $in: ['h-7'] } }],
    });
  });
});

// Against a real Mongo: Hoops salespeople without a HaiVE login are listed by
// their Hoops name in the team views; nothing changes for Pantheras.
describe('team views: Hoops salespeople by their Hoops name (real Mongo)', () => {
  let connection: Connection;
  let deals: Model<DealDocument>;
  let service: DealPerformanceDashboardService;
  const org = `${PREFIX}-org`;
  const roster = [{ _id: { toString: () => 'u1' }, name: 'Vasanth G', roles: ['sales_executive'] }];

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(uri), MongooseModule.forFeature([{ name: Deal.name, schema: DealSchema }])],
    }).compile();
    connection = moduleRef.get(getConnectionToken());
    deals = moduleRef.get(getModelToken(Deal.name));
    const users = { findTeamRoster: async () => roster, findAll: async () => roster };
    service = new DealPerformanceDashboardService(deals, {} as never, users as never, {} as never);

    const deal = (name: string, dealStatus: string, monetaryValue: number, more: Record<string, unknown>) => ({
      organizationId: org,
      name,
      dealStatus,
      monetaryValue,
      expectedClosingDate: '2026-10-15',
      ...more,
    });
    const hoops = { sourceProvider: 'hoops', dataSourceId: 'hoops-src' };
    await connection.collection('crm_deals').insertMany([
      // A HaiVE user's Pantheras sale.
      deal('Polos', 'won', 1000, { sourceProvider: 'prospectconnect', ownerId: 'u1' }),
      // A Pantheras owner nobody linked: not listed, as before.
      deal('Caps', 'won', 500, { sourceProvider: 'prospectconnect', externalOwnerRef: 'pc-9', externalOwnerLabel: 'Pantheras rep' }),
      // Hoops salespeople without a HaiVE login.
      deal('Bags', 'won', 300, { ...hoops, externalOwnerRef: 'h-1', externalOwnerLabel: 'Surryhills Fully Promoted' }),
      deal('Pens', 'won', 200, { ...hoops, externalOwnerRef: 'h-1', externalOwnerLabel: 'Surryhills Fully Promoted' }),
      deal('Hats', 'open', 150, { ...hoops, externalOwnerRef: 'h-1', externalOwnerLabel: 'Surryhills Fully Promoted' }),
      deal('Mugs', 'lost', 90, { ...hoops, externalOwnerRef: 'h-2', externalOwnerLabel: 'Kshitij Hedge' }),
      deal('Tees', 'won', 40, { ...hoops, externalOwnerRef: 'h-3' }),
      // A Hoops salesperson linked to a HaiVE user: credited to that user, not listed twice.
      deal('Jackets', 'won', 700, { ...hoops, externalOwnerRef: 'h-4', externalOwnerLabel: 'Linked person', ownerId: 'u1' }),
    ]);
  });

  afterAll(async () => {
    await connection.collection('crm_deals').deleteMany({ organizationId: org });
    await connection.close();
  });

  it('lists each Hoops salesperson with their own sales, after the HaiVE users — Pantheras unchanged', async () => {
    const rows = await service.getConsultantPerformance(org, { organizationId: org }, undefined, undefined);
    expect(rows.map((r) => [r.userId, r.userName, r.wonCount, r.wonValue, r.lostCount, r.openCount])).toEqual([
      ['u1', 'Vasanth G', 2, 1700, 0, 0],
      [hoopsSalespersonId('h-1'), 'Surryhills Fully Promoted', 2, 500, 0, 1],
      [hoopsSalespersonId('h-3'), 'Hoops salesperson', 1, 40, 0, 0],
      [hoopsSalespersonId('h-2'), 'Kshitij Hedge', 0, 0, 1, 0],
    ]);
    expect(rows.find((r) => r.userId === hoopsSalespersonId('h-1'))).toMatchObject({ pipelineValue: 150, winRate: 100 });
  });

  it('a list of every account (Agent Activity) stays HaiVE users only', async () => {
    const rows = await service.getConsultantPerformance(org, { organizationId: org }, undefined, undefined, true);
    expect(rows.map((r) => r.userId)).toEqual(['u1']);
  });

  it('one person in view (a salesperson looking at their own figures): no Hoops rows', async () => {
    const rows = await service.getConsultantPerformance(org, { organizationId: org, ownerId: 'u1' }, undefined, undefined);
    expect(rows.map((r) => r.userId)).toEqual(['u1']);
  });

  it('a Hoops salesperson row opens their own sales', async () => {
    const found = await deals.find(buildDealMatchStage(org, { ownerId: [hoopsSalespersonId('h-1')] } as never)).lean();
    expect(found.map((d) => d.name).sort()).toEqual(['Bags', 'Hats', 'Pens']);
  });
});
