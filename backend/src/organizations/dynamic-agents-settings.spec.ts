import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection } from 'mongoose';
import { Organization, OrganizationSchema } from './schemas/organization.schema';
import { Store, StoreSchema } from './schemas/store.schema';
import { OrganizationsService } from './organizations.service';

const PREFIX = `jest-dynagents-${Date.now()}`;

// Real Mongo, same convention as every other spec this session — this is
// the persistence half of per-organization overrides for python-agent's
// Dynamic Recursive Multi-Agent System (DYNAMIC_AGENTS_MAX_DEPTH/_PER_REQUEST/
// _EXECUTION_SECONDS, see python-agent/app/agent/dynamic/limits.py).
// Clamping an override down to the platform ceiling is python-agent's own
// org_limits.py's job, NOT tested here — this only proves the settings
// round-trip correctly and that the "last changed by/when" stamp is honest.
describe('OrganizationsService dynamic agents settings', () => {
  let connection: Connection;
  let service: OrganizationsService;
  let orgId: string;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Organization.name, schema: OrganizationSchema },
          { name: Store.name, schema: StoreSchema },
        ]),
      ],
      providers: [OrganizationsService],
    }).compile();
    connection = moduleRef.get(getConnectionToken());
    service = moduleRef.get(OrganizationsService);
  });

  beforeEach(async () => {
    const org = await connection.collection('organizations').insertOne({ name: PREFIX, slug: `${PREFIX}-${Date.now()}-${Math.random()}` });
    orgId = org.insertedId.toString();
  });

  afterAll(async () => {
    await connection.collection('organizations').deleteMany({ name: PREFIX });
    await connection.close();
  });

  it('a fresh organization has no overrides — {} means "use the platform default unmodified"', async () => {
    const settings = await service.getDynamicAgentsSettings(orgId);
    expect(settings).toEqual({});
  });

  it('saves only the fields given, stamps who changed it and when, and round-trips on read', async () => {
    const saved = await service.updateDynamicAgentsSettings(orgId, { maxDepth: 1, maxAgentsPerRequest: 3 }, 'admin-1');

    expect(saved).toMatchObject({ maxDepth: 1, maxAgentsPerRequest: 3, updatedBy: 'admin-1' });
    expect(saved.updatedAt).toBeInstanceOf(Date);
    expect(saved.maxExecutionSeconds).toBeUndefined();

    const reread = await service.getDynamicAgentsSettings(orgId);
    expect(reread).toMatchObject({ maxDepth: 1, maxAgentsPerRequest: 3 });
  });

  it('a second partial save only touches the fields it sent, leaving earlier ones alone', async () => {
    await service.updateDynamicAgentsSettings(orgId, { maxDepth: 2, maxAgentsPerRequest: 4 }, 'admin-1');
    const after = await service.updateDynamicAgentsSettings(orgId, { maxExecutionSeconds: 90 }, 'admin-2');

    expect(after).toMatchObject({ maxDepth: 2, maxAgentsPerRequest: 4, maxExecutionSeconds: 90, updatedBy: 'admin-2' });
  });

  it('organization isolation: one organization saving its own override never touches another organization\'s', async () => {
    const otherOrg = await connection.collection('organizations').insertOne({ name: PREFIX, slug: `${PREFIX}-other-${Date.now()}` });
    const otherOrgId = otherOrg.insertedId.toString();

    await service.updateDynamicAgentsSettings(orgId, { maxDepth: 1 }, 'admin-1');

    const otherSettings = await service.getDynamicAgentsSettings(otherOrgId);
    expect(otherSettings).toEqual({});
  });

  // --- Per-organization rollout gate (production rollout, built on top of
  // the settings doc above — see UpdateDynamicAgentsSettingsDto's own
  // comment: this is layered ON TOP of python-agent's deployment-wide
  // DYNAMIC_AGENTS_ENABLED env flag, not instead of it) ---

  it('a fresh organization defaults to disabled — opt-in, not opt-out, for a capability this new', async () => {
    const settings = await service.getDynamicAgentsSettings(orgId);
    expect(settings.enabled).toBeUndefined();
  });

  it('enabling one organization never enables another', async () => {
    const otherOrg = await connection.collection('organizations').insertOne({ name: PREFIX, slug: `${PREFIX}-other2-${Date.now()}` });
    const otherOrgId = otherOrg.insertedId.toString();

    await service.updateDynamicAgentsSettings(orgId, { enabled: true }, 'admin-1');

    expect((await service.getDynamicAgentsSettings(orgId)).enabled).toBe(true);
    expect((await service.getDynamicAgentsSettings(otherOrgId)).enabled).toBeUndefined();
  });

  it('can be turned back off with an explicit false, not just left unset', async () => {
    await service.updateDynamicAgentsSettings(orgId, { enabled: true }, 'admin-1');
    await service.updateDynamicAgentsSettings(orgId, { enabled: false }, 'admin-2');

    expect((await service.getDynamicAgentsSettings(orgId)).enabled).toBe(false);
  });

  // Phase 2.5, Sub-step C's remaining execution-limit dimensions — same
  // persistence-only round-trip as maxDepth/maxAgentsPerRequest/
  // maxExecutionSeconds above; python-agent's own org_limits.py is the
  // real authority on clamping these down to the platform ceiling, not
  // tested here.
  it('saves and round-trips the 5 execution-limit fields Sub-step C added', async () => {
    const saved = await service.updateDynamicAgentsSettings(
      orgId,
      { maxRetries: 1, maxModelCalls: 20, maxToolCalls: 30, maxTokens: 100_000, maxCostUsd: 1.5 },
      'admin-1',
    );

    expect(saved).toMatchObject({ maxRetries: 1, maxModelCalls: 20, maxToolCalls: 30, maxTokens: 100_000, maxCostUsd: 1.5 });

    const reread = await service.getDynamicAgentsSettings(orgId);
    expect(reread).toMatchObject({ maxRetries: 1, maxModelCalls: 20, maxToolCalls: 30, maxTokens: 100_000, maxCostUsd: 1.5 });
  });
});
