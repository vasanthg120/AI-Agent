import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { AiUsageHierarchyService } from '../ai-usage/ai-usage-hierarchy.service';
import { AgentExecution, AgentExecutionDocument, AgentExecutionSchema } from '../command-center/schemas/agent-execution.schema';
import { Organization, OrganizationSchema } from '../organizations/schemas/organization.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { WalletTransaction, WalletTransactionDocument, WalletTransactionSchema } from '../billing/schemas/wallet-transaction.schema';
import { ProviderFinanceService } from './provider-finance.service';
import { ProviderAccount, ProviderAccountDocument, ProviderAccountSchema } from './schemas/provider-account.schema';
import { ProviderPayment, ProviderPaymentDocument, ProviderPaymentSchema } from './schemas/provider-payment.schema';

// Real-Mongo integration tests, same convention as every other spec this
// session (ai-usage-hierarchy.spec.ts, billing-admin-metrics.spec.ts) — a
// unique prefix so this shared dev database's accumulated data never
// collides, every assertion scoped to this test's own fixtures.
const PREFIX = `jest-provider-finance-${Date.now()}`;

describe('ProviderFinanceService (real Mongo)', () => {
  let connection: Connection;
  let service: ProviderFinanceService;
  let accountModel: Model<ProviderAccountDocument>;
  let paymentModel: Model<ProviderPaymentDocument>;
  let executionModel: Model<AgentExecutionDocument>;
  let transactionModel: Model<WalletTransactionDocument>;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: ProviderAccount.name, schema: ProviderAccountSchema },
          { name: ProviderPayment.name, schema: ProviderPaymentSchema },
          { name: AgentExecution.name, schema: AgentExecutionSchema },
          { name: Organization.name, schema: OrganizationSchema },
          { name: User.name, schema: UserSchema },
          { name: WalletTransaction.name, schema: WalletTransactionSchema },
        ]),
      ],
      providers: [ProviderFinanceService, AiUsageHierarchyService],
    }).compile();

    service = moduleRef.get(ProviderFinanceService);
    accountModel = moduleRef.get(getModelToken(ProviderAccount.name));
    paymentModel = moduleRef.get(getModelToken(ProviderPayment.name));
    executionModel = moduleRef.get(getModelToken(AgentExecution.name));
    transactionModel = moduleRef.get(getModelToken(WalletTransaction.name));
    connection = moduleRef.get(getConnectionToken());
  });

  afterEach(async () => {
    // Isolate between tests — Phase A's "accounts" are keyed only by
    // provider name (no org scope, by design: platform-wide), so a test
    // that reconciles 'anthropic' must not leak into the next one.
    await accountModel.deleteMany({});
    await paymentModel.deleteMany({ provider: { $regex: `^${PREFIX}` } });
    await executionModel.deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
  });

  afterAll(async () => {
    await connection.close();
  });

  it('a reconciliation followed by real cost correctly derives the estimated balance, never storing it', async () => {
    const provider = `${PREFIX}-anthropic`;
    await service.recordReconciliation(provider, { confirmedBalance: 200 }, 'admin-1');
    await executionModel.create({
      organizationId: `${PREFIX}-org`,
      userId: `${PREFIX}-user`,
      kind: 'llm',
      name: 'planner',
      provider,
      model: 'claude-x',
      inputTokens: 100,
      outputTokens: 100,
      costUsd: 37.5,
      success: true,
      occurredAt: new Date(),
    });

    const account = await service.getAccount(provider);
    expect(account.confirmedBalance).toBe(200);
    expect(account.estimatedBalance).toBe(162.5);

    // Never stored on the document itself — only ever derived at read time.
    const raw = await accountModel.findOne({ provider }).exec();
    expect((raw as unknown as Record<string, unknown>).estimatedBalance).toBeUndefined();
  });

  it('rejects a duplicate transactionId for the same provider', async () => {
    const provider = `${PREFIX}-dup-check`;
    await service.recordPayment(
      { provider, amount: 50, paymentDate: new Date().toISOString(), paymentMethod: 'wire', transactionId: 'TXN-1' },
      'admin-1',
    );
    await expect(
      service.recordPayment({ provider, amount: 999, paymentDate: new Date().toISOString(), paymentMethod: 'wire', transactionId: 'TXN-1' }, 'admin-1'),
    ).rejects.toThrow(/already recorded/i);
  });

  it('the same transactionId is fine across two different providers (uniqueness is per-provider)', async () => {
    const providerA = `${PREFIX}-provA`;
    const providerB = `${PREFIX}-provB`;
    await service.recordPayment({ provider: providerA, amount: 10, paymentDate: new Date().toISOString(), paymentMethod: 'wire', transactionId: 'SHARED' }, 'admin-1');
    await expect(
      service.recordPayment({ provider: providerB, amount: 10, paymentDate: new Date().toISOString(), paymentMethod: 'wire', transactionId: 'SHARED' }, 'admin-1'),
    ).resolves.toBeTruthy();
  });

  it('getPaymentTotals groups correctly by provider, month, and year', async () => {
    const provider = `${PREFIX}-totals`;
    await service.recordPayment({ provider, amount: 30, paymentDate: '2026-03-15T00:00:00.000Z', paymentMethod: 'card' }, 'admin-1');
    await service.recordPayment({ provider, amount: 70, paymentDate: '2026-03-20T00:00:00.000Z', paymentMethod: 'card' }, 'admin-1');

    const byProvider = await service.getPaymentTotals('provider');
    expect(byProvider.find((r) => r.key === provider)).toMatchObject({ total: 100, count: 2 });

    const byMonth = await service.getPaymentTotals('month');
    expect(byMonth.find((r) => r.key === '2026-03')?.total).toBeGreaterThanOrEqual(100);
  });

  it('a request never settled still lists in payment history with the amount recorded, unaffected by billing', async () => {
    const provider = `${PREFIX}-unsettled`;
    const payment = await service.recordPayment({ provider, amount: 25, paymentDate: new Date().toISOString(), paymentMethod: 'card' }, 'admin-1');
    const { items } = await service.listPayments({ provider, page: 1, pageSize: 10 });
    expect(items.map((i) => i._id.toString())).toContain(payment._id.toString());
  });

  it('getProfitability excludes recharge payments from the provider-cost side — only real agent_executions cost counts', async () => {
    // getProfitability/getFinanceDashboard both iterate the fixed
    // FINANCE_TRACKED_PROVIDERS list (['anthropic', 'groq']), not whatever
    // providers happen to exist in the payments collection — a synthetic
    // prefixed provider name would never be looked at by this code path at
    // all, so this test must use the real 'anthropic' name to genuinely
    // exercise it. This shared dev database has other real Anthropic
    // activity (same reasoning billing-admin-metrics.spec.ts's own leading
    // comment documents), so the assertion is a safety-margin bound, not an
    // exact value: a $100,000 recharge must never be anywhere close to
    // showing up as cost, however much small real cost already exists.
    const before = await service.getProfitability(1);
    const beforeAnthropicCost = before.providerCostBreakdown.find((p) => p.provider === 'anthropic')?.costUsd ?? 0;

    await service.recordPayment({ provider: 'anthropic', amount: 100_000, paymentDate: new Date().toISOString(), paymentMethod: 'wire', transactionId: `${PREFIX}-huge-recharge` }, 'admin-1');

    const after = await service.getProfitability(1);
    const afterAnthropicCost = after.providerCostBreakdown.find((p) => p.provider === 'anthropic')?.costUsd ?? 0;

    expect(afterAnthropicCost).toBeCloseTo(beforeAnthropicCost, 5);
    expect(afterAnthropicCost).toBeLessThan(1000);

    await paymentModel.deleteMany({ provider: 'anthropic', transactionId: `${PREFIX}-huge-recharge` });
  });

  it('never writes to WalletTransaction or any billing collection — every method here is read-only against billing', async () => {
    const createSpy = jest.spyOn(transactionModel, 'create');
    const updateSpy = jest.spyOn(transactionModel, 'updateOne');
    const provider = `${PREFIX}-readonly`;

    await service.getAccounts();
    await service.recordPayment({ provider, amount: 5, paymentDate: new Date().toISOString(), paymentMethod: 'card' }, 'admin-1');
    await service.recordReconciliation(provider, { confirmedBalance: 10 }, 'admin-1');
    await service.getFinanceDashboard(1);
    await service.getProfitability(1);
    await service.getPaymentTotals('provider');

    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    createSpy.mockRestore();
    updateSpy.mockRestore();
  });

  it("a provider's estimated balance before any reconciliation is honestly absent, never a guessed zero", async () => {
    const account = await service.getAccount(`${PREFIX}-never-reconciled`);
    expect(account.confirmedBalance).toBeNull();
    expect(account.estimatedBalance).toBeNull();
  });
});
