import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model, Types } from 'mongoose';
import { AgentExecution, AgentExecutionDocument, AgentExecutionSchema } from '../command-center/schemas/agent-execution.schema';
import { BillingAdminEntitlementsService } from './billing-admin-entitlements.service';
import { AI_USAGE_FEATURE_KEY, EntitlementsUsageAggregationService } from './entitlements-usage-aggregation.service';
import { EntitlementsService } from './entitlements.service';
import { BillingPlan, BillingPlanDocument, BillingPlanSchema } from './schemas/billing-plan.schema';
import { BillingSubscription, BillingSubscriptionDocument, BillingSubscriptionSchema } from './schemas/billing-subscription.schema';
import { Entitlement, EntitlementDocument, EntitlementSchema } from './schemas/entitlement.schema';
import { UsageAggregationCursor, UsageAggregationCursorDocument, UsageAggregationCursorSchema } from './schemas/usage-aggregation-cursor.schema';
import { UsageRecord, UsageRecordDocument, UsageRecordSchema } from './schemas/usage-record.schema';

// Real-Mongo integration tests for Phase 0 of the ChatGPT-style entitlements
// migration (see entitlements.service.ts) — canAccess against a boolean and
// a numeric grant, the no-subscription case, admin catalog CRUD, and the
// agent_executions -> usage_records aggregation job's rollup correctness
// and idempotent re-run. Nothing here touches the wallet/reservation path.

const TEST_PREFIX = `jest-entitlements-${Date.now()}`;

describe('Phase 0 entitlements (real Mongo)', () => {
  let connection: Connection;
  let entitlementsService: EntitlementsService;
  let adminEntitlementsService: BillingAdminEntitlementsService;
  let aggregationService: EntitlementsUsageAggregationService;

  let entitlementModel: Model<EntitlementDocument>;
  let planModel: Model<BillingPlanDocument>;
  let subscriptionModel: Model<BillingSubscriptionDocument>;
  let usageModel: Model<UsageRecordDocument>;
  let executionModel: Model<AgentExecutionDocument>;
  let cursorModel: Model<UsageAggregationCursorDocument>;
  // Set only if this test run is the one that actually inserted the
  // ai_usage catalog row (see the numeric-entitlement test below) — never
  // deletes a pre-existing real entitlement a live admin may have created.
  let aiUsageEntitlementId: string | undefined;

  // agent_executions is the real, shared dev collection — a single run()
  // only advances one bounded batch (billing_usage_aggregation_cursor is a
  // real, permanent, forward-only cursor shared with the live app's own
  // hourly cron, so it's deliberately never reset here). Loop to full
  // catch-up before asserting, same as a real deploy working through a
  // backlog.
  async function runAggregationUntilCaughtUp(maxIterations = 500): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxIterations; i++) {
      const processed = await aggregationService.run();
      total += processed;
      if (processed === 0) return total;
    }
    throw new Error(`Aggregation did not catch up within ${maxIterations} iterations.`);
  }

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Entitlement.name, schema: EntitlementSchema },
          { name: BillingPlan.name, schema: BillingPlanSchema },
          { name: BillingSubscription.name, schema: BillingSubscriptionSchema },
          { name: UsageRecord.name, schema: UsageRecordSchema },
          { name: AgentExecution.name, schema: AgentExecutionSchema },
          { name: UsageAggregationCursor.name, schema: UsageAggregationCursorSchema },
        ]),
      ],
      providers: [EntitlementsService, BillingAdminEntitlementsService, EntitlementsUsageAggregationService],
    }).compile();

    connection = moduleRef.get(getModelToken(Entitlement.name)).db;
    entitlementsService = moduleRef.get(EntitlementsService);
    adminEntitlementsService = moduleRef.get(BillingAdminEntitlementsService);
    aggregationService = moduleRef.get(EntitlementsUsageAggregationService);

    entitlementModel = moduleRef.get(getModelToken(Entitlement.name));
    planModel = moduleRef.get(getModelToken(BillingPlan.name));
    subscriptionModel = moduleRef.get(getModelToken(BillingSubscription.name));
    usageModel = moduleRef.get(getModelToken(UsageRecord.name));
    executionModel = moduleRef.get(getModelToken(AgentExecution.name));
    cursorModel = moduleRef.get(getModelToken(UsageAggregationCursor.name));
  });

  afterAll(async () => {
    await entitlementModel.deleteMany({ key: { $regex: `^${TEST_PREFIX}` } });
    if (aiUsageEntitlementId) await entitlementModel.deleteOne({ _id: aiUsageEntitlementId });
    await planModel.deleteMany({ key: { $regex: `^${TEST_PREFIX}` } });
    await subscriptionModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await usageModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await executionModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    // billing_usage_aggregation_cursor is deliberately left untouched — see
    // the runAggregationUntilCaughtUp comment above.
    await connection.close();
  });

  describe('BillingAdminEntitlementsService (catalog CRUD)', () => {
    it('creates an entitlement, rejects a duplicate key, and can deactivate/reactivate it', async () => {
      const key = `${TEST_PREFIX}-boolean-flag`;
      const created = await adminEntitlementsService.createEntitlement({ key, name: 'Boolean Flag', type: 'boolean' });
      expect(created.active).toBe(true);

      await expect(adminEntitlementsService.createEntitlement({ key, name: 'Dup', type: 'boolean' })).rejects.toThrow();

      const deactivated = await adminEntitlementsService.setActive(created._id.toString(), false);
      expect(deactivated.active).toBe(false);
      const reactivated = await adminEntitlementsService.setActive(created._id.toString(), true);
      expect(reactivated.active).toBe(true);
    });

    it('throws NotFoundException for an unknown id', async () => {
      await expect(adminEntitlementsService.getEntitlement('000000000000000000000000')).rejects.toThrow();
    });
  });

  describe('EntitlementsService.canAccess', () => {
    const organizationId = `${TEST_PREFIX}-org-1`;

    it('denies access when the org has no active subscription', async () => {
      const entitlement = await entitlementModel.create({ key: `${TEST_PREFIX}-no-sub`, name: 'No Sub', type: 'boolean' });
      const result = await entitlementsService.canAccess(organizationId, entitlement.key);
      expect(result.allowed).toBe(false);
    });

    it('resolves a boolean entitlement from the org\'s current plan grant', async () => {
      const entitlement = await entitlementModel.create({ key: `${TEST_PREFIX}-priority-support`, name: 'Priority Support', type: 'boolean' });
      const plan = await planModel.create({
        key: `${TEST_PREFIX}-pro`,
        name: 'Pro',
        entitlements: [{ key: entitlement.key, enabled: true }],
      });
      await subscriptionModel.create({
        organizationId,
        planId: plan._id.toString(),
        planPriceId: new Types.ObjectId().toString(),
        status: 'active',
        currentPeriodStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000),
        createdBy: 'test',
      });

      const result = await entitlementsService.canAccess(organizationId, entitlement.key);
      expect(result.allowed).toBe(true);
      expect(result.type).toBe('boolean');
    });

    it('resolves a numeric entitlement against aggregated usage_records within the current period', async () => {
      const orgId = `${TEST_PREFIX}-org-2`;
      // AI_USAGE_FEATURE_KEY is the one fixed catalog key the aggregation
      // job ever writes against (see usage-record.schema.ts's scoping
      // note) — it's a real, permanent catalog concept shared across the
      // whole dev database, not a TEST_PREFIX-scoped throwaway, so it's
      // upserted (never duplicate-key crashes on a re-run) and deleted by
      // its exact _id in afterAll rather than by the TEST_PREFIX regex.
      const entitlement = await entitlementModel
        .findOneAndUpdate(
          { key: AI_USAGE_FEATURE_KEY },
          { $setOnInsert: { key: AI_USAGE_FEATURE_KEY, name: 'Monthly AI Usage', type: 'numeric', active: true } },
          { upsert: true, new: true },
        )
        .exec();
      aiUsageEntitlementId = entitlement._id.toString();
      const plan = await planModel.create({
        key: `${TEST_PREFIX}-plus`,
        name: 'Plus',
        entitlements: [{ key: entitlement.key, enabled: true, value: 1000 }],
      });
      const periodStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const periodEnd = new Date(Date.now() + 29 * 24 * 60 * 60 * 1000);
      await subscriptionModel.create({
        organizationId: orgId,
        planId: plan._id.toString(),
        planPriceId: new Types.ObjectId().toString(),
        status: 'active',
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        createdBy: 'test',
      });

      // Seed raw agent_executions rows and run the aggregation job — proves
      // the full read path (execution -> UsageRecord rollup -> canAccess),
      // not just canAccess against a hand-inserted UsageRecord.
      const now = new Date();
      await executionModel.create([
        { organizationId: orgId, kind: 'llm', name: 'chat', model: 'claude', inputTokens: 300, outputTokens: 200, totalTokens: 500, occurredAt: now },
        { organizationId: orgId, kind: 'llm', name: 'chat', model: 'claude', inputTokens: 100, outputTokens: 100, totalTokens: 200, occurredAt: now },
      ]);
      // agent_executions is a real, shared dev collection with plenty of
      // pre-existing rows from ordinary app usage — a single run() only
      // advances one bounded batch (matching subscription-renewal.service.ts's
      // own bounded-.limit() convention), so it can take more than one tick
      // to actually reach our just-inserted rows. Loop to full catch-up
      // before asserting, same as a real deploy catching up on a backlog.
      const processed = await runAggregationUntilCaughtUp();
      expect(processed).toBeGreaterThanOrEqual(2);

      const underLimit = await entitlementsService.canAccess(orgId, entitlement.key);
      expect(underLimit.allowed).toBe(true);
      expect(underLimit.limit).toBe(1000);
      expect(underLimit.used).toBe(700);
      expect(underLimit.remaining).toBe(300);

      // Re-running the aggregation must not double-count already-processed
      // executions (the cursor should have advanced past them).
      const reprocessed = await runAggregationUntilCaughtUp();
      expect(reprocessed).toBe(0);
      const stillUnderLimit = await entitlementsService.canAccess(orgId, entitlement.key);
      expect(stillUnderLimit.used).toBe(700);

      // Push usage over the plan's cap with a fresh execution and confirm
      // access flips to denied once used >= limit.
      await executionModel.create({
        organizationId: orgId,
        kind: 'llm',
        name: 'chat',
        model: 'claude',
        inputTokens: 200,
        outputTokens: 200,
        totalTokens: 400,
        occurredAt: now,
      });
      await runAggregationUntilCaughtUp();
      const overLimit = await entitlementsService.canAccess(orgId, entitlement.key);
      expect(overLimit.used).toBe(1100);
      expect(overLimit.allowed).toBe(false);
      expect(overLimit.remaining).toBe(0);
    });

    it('returns denied for an unknown entitlement key', async () => {
      const result = await entitlementsService.canAccess(organizationId, `${TEST_PREFIX}-does-not-exist`);
      expect(result.allowed).toBe(false);
    });
  });
});
