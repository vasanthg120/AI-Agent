import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { StatusDefinition, StatusDefinitionDocument, StatusDefinitionSchema } from './schemas/status-definition.schema';
import { StatusDefinitionsService } from './status-definitions.service';

// Phase 2a of the Hoops-parity plan — proves the one invariant that makes
// this phase safe: seeding is idempotent and never overwrites an admin's
// existing customization, and no caller can introduce a status key the
// rest of the app (dashboards, revenue math) doesn't already recognize.
const PREFIX = `jest-status-definitions-${Date.now()}`;

describe('StatusDefinitionsService (real Mongo)', () => {
  let connection: Connection;
  let model: Model<StatusDefinitionDocument>;
  let service: StatusDefinitionsService;
  let seq = 0;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([{ name: StatusDefinition.name, schema: StatusDefinitionSchema }]),
      ],
    }).compile();
    connection = moduleRef.get(getConnectionToken());
    model = moduleRef.get(getModelToken(StatusDefinition.name));
    await model.init();
    service = new StatusDefinitionsService(model);
  });

  afterAll(async () => {
    await model.deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await connection.close();
  });

  beforeEach(() => {
    seq += 1;
  });

  it('lists the seeded defaults for deal.dealStatus, matching the real Mongoose enum exactly', async () => {
    const org = `${PREFIX}-org-${seq}`;
    const result = await service.list(org, 'deal.dealStatus');
    expect(result.map((d) => d.key)).toEqual(['open', 'won', 'lost']);
    expect(result.every((d) => d.active)).toBe(true);
  });

  it('lists the seeded defaults for quote.clientApprovalStatus', async () => {
    const org = `${PREFIX}-org-${seq}`;
    const result = await service.list(org, 'quote.clientApprovalStatus');
    expect(result.map((d) => d.key)).toEqual(['pending', 'approved']);
  });

  it('lists the seeded defaults for quote.quoteStatus (added for the SalesBoard)', async () => {
    const org = `${PREFIX}-org-${seq}`;
    const result = await service.list(org, 'quote.quoteStatus');
    expect(result.map((d) => d.key)).toEqual(['draft', 'published', 'sent']);
  });

  it('rejects an unknown field without creating anything', async () => {
    const org = `${PREFIX}-org-${seq}`;
    await expect(service.list(org, 'deal.someMadeUpField')).rejects.toThrow(BadRequestException);
    const count = await model.countDocuments({ organizationId: org });
    expect(count).toBe(0);
  });

  it('seeding is idempotent: listing the same org/field twice never duplicates rows', async () => {
    const org = `${PREFIX}-org-${seq}`;
    await service.list(org, 'deal.dealStatus');
    await service.list(org, 'deal.dealStatus');
    const count = await model.countDocuments({ organizationId: org, field: 'deal.dealStatus' });
    expect(count).toBe(3);
  });

  it('relabeling an existing key updates its label/color and persists across later lists', async () => {
    const org = `${PREFIX}-org-${seq}`;
    const updated = await service.relabel(org, 'deal.dealStatus', 'won', { label: 'Closed Won', color: '#00ff00' });
    expect(updated.label).toBe('Closed Won');
    expect(updated.color).toBe('#00ff00');

    const relisted = await service.list(org, 'deal.dealStatus');
    const won = relisted.find((d) => d.key === 'won');
    expect(won?.label).toBe('Closed Won');
  });

  it('relabeling is scoped to one field only — the same key under a different field is untouched', async () => {
    const org = `${PREFIX}-org-${seq}`;
    await service.relabel(org, 'deal.dealStatus', 'open', { label: 'Renamed Open' });
    // quote.clientApprovalStatus has no 'open' key at all — unaffected either way,
    // but prove the deal-side rename didn't leak into a shared row by key alone.
    const dealOpen = (await service.list(org, 'deal.dealStatus')).find((d) => d.key === 'open');
    expect(dealOpen?.label).toBe('Renamed Open');
  });

  it('rejects relabeling a key that was never seeded — cannot be used to invent a new status', async () => {
    const org = `${PREFIX}-org-${seq}`;
    await expect(service.relabel(org, 'deal.dealStatus', 'archived', { label: 'Archived' })).rejects.toThrow(
      NotFoundException,
    );
    const count = await model.countDocuments({ organizationId: org, field: 'deal.dealStatus', key: 'archived' });
    expect(count).toBe(0);
  });

  it('a later seed-triggering list() never overwrites a prior customization', async () => {
    const org = `${PREFIX}-org-${seq}`;
    await service.list(org, 'deal.dealStatus'); // first seed
    await service.relabel(org, 'deal.dealStatus', 'lost', { label: 'Customer Declined' });

    await service.list(org, 'deal.dealStatus'); // re-list — must not reset the customization
    await service.list(org, 'deal.dealStatus');

    const lost = (await service.list(org, 'deal.dealStatus')).find((d) => d.key === 'lost');
    expect(lost?.label).toBe('Customer Declined');
  });

  it('organization isolation: one org customizing a status never affects another org\'s defaults', async () => {
    const orgA = `${PREFIX}-org-a-${seq}`;
    const orgB = `${PREFIX}-org-b-${seq}`;
    await service.relabel(orgA, 'deal.dealStatus', 'won', { label: 'A-Won' });

    const bWon = (await service.list(orgB, 'deal.dealStatus')).find((d) => d.key === 'won');
    expect(bWon?.label).toBe('Won'); // untouched default, not 'A-Won'
  });

  it('concurrent first-time listing from two requests never creates duplicate rows (race safety)', async () => {
    const org = `${PREFIX}-org-${seq}`;
    await Promise.all([service.list(org, 'deal.dealStatus'), service.list(org, 'deal.dealStatus'), service.list(org, 'deal.dealStatus')]);
    const count = await model.countDocuments({ organizationId: org, field: 'deal.dealStatus' });
    expect(count).toBe(3);
  });
});
