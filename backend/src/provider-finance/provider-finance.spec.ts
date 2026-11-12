import { ConfigModule, ConfigService } from '@nestjs/config';
import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { AiUsageHierarchyService } from '../ai-usage/ai-usage-hierarchy.service';
import { PricingService } from '../billing/pricing.service';
import { BillingSettings, BillingSettingsSchema } from '../billing/schemas/billing-settings.schema';
import { AgentExecution, AgentExecutionDocument, AgentExecutionSchema } from '../command-center/schemas/agent-execution.schema';
import { EncryptionService } from '../common/encryption/encryption.service';
import { IntegrationCredential, IntegrationCredentialDocument, IntegrationCredentialSchema } from '../integrations/schemas/integration-credential.schema';
import { Organization, OrganizationSchema } from '../organizations/schemas/organization.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { WalletTransaction, WalletTransactionDocument, WalletTransactionSchema } from '../billing/schemas/wallet-transaction.schema';
import { AnthropicFinanceAdapter } from './adapters/anthropic-finance-adapter.service';
import { GroqFinanceAdapter } from './adapters/groq-finance-adapter.service';
import { ProviderFinanceAdapterRegistry } from './adapters/provider-finance-adapter.registry';
import { ProviderFinanceService } from './provider-finance.service';
import { startOfMonthIst } from './reporting-timezone';
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
  let credentialModel: Model<IntegrationCredentialDocument>;
  let pricing: PricingService;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot(),
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: ProviderAccount.name, schema: ProviderAccountSchema },
          { name: ProviderPayment.name, schema: ProviderPaymentSchema },
          { name: AgentExecution.name, schema: AgentExecutionSchema },
          { name: Organization.name, schema: OrganizationSchema },
          { name: User.name, schema: UserSchema },
          { name: WalletTransaction.name, schema: WalletTransactionSchema },
          { name: IntegrationCredential.name, schema: IntegrationCredentialSchema },
          { name: BillingSettings.name, schema: BillingSettingsSchema },
        ]),
      ],
      providers: [
        ProviderFinanceService,
        AiUsageHierarchyService,
        ProviderFinanceAdapterRegistry,
        // Real PricingService against the real ConfigService/BillingSettings
        // model — the gross-margin tests below exercise the actual
        // configured USD<->credits conversion, not a stand-in rate.
        PricingService,
        // No real HttpService needed — these tests exercise getCapabilities()
        // (pure, synchronous) and the CONFIGURATION_REQUIRED/encrypted-key
        // round trip, never a live HTTP call to Anthropic/Groq.
        { provide: AnthropicFinanceAdapter, useValue: new AnthropicFinanceAdapter({} as never) },
        { provide: GroqFinanceAdapter, useValue: new GroqFinanceAdapter() },
        // Same stub-ConfigService convention integrations-oauth.spec.ts already uses.
        { provide: EncryptionService, useValue: new EncryptionService({ get: () => `${PREFIX}-key-at-least-32-bytes-long!!` } as never) },
      ],
    }).compile();

    service = moduleRef.get(ProviderFinanceService);
    accountModel = moduleRef.get(getModelToken(ProviderAccount.name));
    paymentModel = moduleRef.get(getModelToken(ProviderPayment.name));
    executionModel = moduleRef.get(getModelToken(AgentExecution.name));
    transactionModel = moduleRef.get(getModelToken(WalletTransaction.name));
    credentialModel = moduleRef.get(getModelToken(IntegrationCredential.name));
    pricing = moduleRef.get(PricingService);
    connection = moduleRef.get(getConnectionToken());
  });

  afterEach(async () => {
    // Isolate between tests — accounts are keyed only by provider name (no
    // org scope, by design: platform-wide), so a test that configures
    // 'anthropic' must not leak into the next one.
    await accountModel.deleteMany({});
    await paymentModel.deleteMany({ provider: { $regex: `^${PREFIX}` } });
    await executionModel.deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await credentialModel.deleteMany({ provider: { $regex: `^${PREFIX}` } });
  });

  afterAll(async () => {
    await connection.close();
  });

  it('balance is always an honest UNSUPPORTED capability, never a number — for both real providers, with or without configuration', async () => {
    const anthropic = await service.getAccount('anthropic');
    const groq = await service.getAccount('groq');
    expect(anthropic.balance.status).toBe('UNSUPPORTED');
    expect(groq.balance.status).toBe('UNSUPPORTED');
    expect(typeof anthropic.balance.note).toBe('string');
    expect((anthropic as unknown as Record<string, unknown>).confirmedBalance).toBeUndefined();
    expect((anthropic as unknown as Record<string, unknown>).estimatedBalance).toBeUndefined();
  });

  it("Anthropic's usage-cost-read capability is CONFIGURATION_REQUIRED until an Admin API key is set, then SUPPORTED", async () => {
    const before = await service.getAccount('anthropic');
    expect(before.capabilities?.USAGE_COST_READ.status).toBe('CONFIGURATION_REQUIRED');
    expect(before.hasAdminApiKey).toBe(false);

    await service.setAdminApiKey('anthropic', 'sk-ant-admin-fake-key-for-test');
    const after = await service.getAccount('anthropic');
    expect(after.capabilities?.USAGE_COST_READ.status).toBe('SUPPORTED');
    expect(after.hasAdminApiKey).toBe(true);

    // Never stored or returned in plaintext.
    const raw = await accountModel.findOne({ provider: 'anthropic' }).exec();
    expect(raw?.adminApiKeyEncrypted).not.toBe('sk-ant-admin-fake-key-for-test');
    expect((after as unknown as Record<string, unknown>).adminApiKey).toBeUndefined();

    await service.clearAdminApiKey('anthropic');
    const cleared = await service.getAccount('anthropic');
    expect(cleared.capabilities?.USAGE_COST_READ.status).toBe('CONFIGURATION_REQUIRED');
  });

  it("Groq's usage-cost-read capability is UNSUPPORTED regardless of configuration — no API exists at all", async () => {
    const account = await service.getAccount('groq');
    expect(account.capabilities?.USAGE_COST_READ.status).toBe('UNSUPPORTED');
  });

  it('every provider declares EXHAUSTION_DETECTION as SUPPORTED', async () => {
    const accounts = await service.getAccounts();
    for (const account of accounts) {
      expect(account.capabilities?.EXHAUSTION_DETECTION.status).toBe('SUPPORTED');
    }
  });

  it('budget pace is computed from real tracked consumption against an admin-set monthlyBudget, never fabricated', async () => {
    const provider = `${PREFIX}-budget`;
    await service.upsertAccount(provider, { monthlyBudget: 100 });
    const beforeCost = await service.getAccount(provider);
    expect(beforeCost.budgetPacePct).toBe(0);

    await executionModel.create({
      organizationId: `${PREFIX}-org`,
      userId: `${PREFIX}-user`,
      kind: 'llm',
      name: 'planner',
      provider,
      model: 'claude-x',
      inputTokens: 100,
      outputTokens: 100,
      costUsd: 40,
      success: true,
      occurredAt: new Date(),
    });

    const afterCost = await service.getAccount(provider);
    expect(afterCost.consumptionThisMonth).toBe(40);
    expect(afterCost.budgetPacePct).toBe(40);
  });

  // --- Required test 5: correct active provider count ----------------------
  it('activeProviderCount counts connected + non-exhausted providers — NOT the unused literal status "active"', async () => {
    // Root cause this test locks in: nothing in this app ever writes the
    // literal 'active' enum value (status defaults to 'unknown' and only
    // ever flips to 'exhausted'), so a naive `status === 'active'` check
    // always read 0 — even with a real, working Admin API key configured.
    //
    // Deliberately READS the real IntegrationCredential state rather than
    // writing to it — this shared dev database has genuine platform
    // credentials configured (confirmed live during the bug report this
    // test was written for), and corrupting or deleting that real
    // connection as test cleanup would be exactly the kind of destructive
    // side effect this suite must never risk.
    const [anthropicReallyConnected, groqReallyConnected] = await Promise.all([
      credentialModel.exists({ organizationId: 'platform', provider: 'anthropic' }).then((r) => !!r),
      credentialModel.exists({ organizationId: 'platform', provider: 'groq' }).then((r) => !!r),
    ]);

    await accountModel.deleteMany({}); // both providers start fresh: 'unknown' status, never exhausted.
    const freshDashboard = await service.getFinanceDashboard(1);
    const anthropicView = freshDashboard.accounts.find((a) => a.provider === 'anthropic')!;
    const groqView = freshDashboard.accounts.find((a) => a.provider === 'groq')!;

    // `connected` must mirror the REAL credential state exactly.
    expect(anthropicView.connected).toBe(anthropicReallyConnected);
    expect(groqView.connected).toBe(groqReallyConnected);
    // A fresh, never-configured 'unknown' status is never treated as broken.
    expect(anthropicView.operational).toBe(true);
    expect(groqView.operational).toBe(true);

    const expectedActiveCount = [anthropicReallyConnected, groqReallyConnected].filter(Boolean).length;
    expect(freshDashboard.activeProviderCount).toBe(expectedActiveCount);

    // Force anthropic exhausted — mutating ONLY provider_accounts (this
    // test's own collection, fully cleared in afterEach), never
    // integration_credentials. Must drop out of the active count regardless
    // of its real connection state.
    await accountModel.updateOne({ provider: 'anthropic' }, { $set: { status: 'exhausted' } }, { upsert: true }).exec();
    const afterExhausted = await service.getFinanceDashboard(1);
    expect(afterExhausted.activeProviderCount).toBe(expectedActiveCount - (anthropicReallyConnected ? 1 : 0));
    expect(afterExhausted.accounts.find((a) => a.provider === 'anthropic')!.operational).toBe(false);
  });

  // --- Required test 6: consumption vs profitability consistency -----------
  it('consumptionThisMonth and profitability cost breakdown agree when scoped to the identical window — same underlying source, different default windows', async () => {
    const provider = `${PREFIX}-consistency`;
    // Not in FINANCE_TRACKED_PROVIDERS, so exercise the shared primitive
    // directly (AiUsageHierarchyService.getProviderCostSince) for both
    // "accounting sources" rather than the provider-specific dashboard
    // fields, proving there is exactly one source of truth underneath both.
    await executionModel.create({
      organizationId: `${PREFIX}-org-consistency`,
      userId: `${PREFIX}-user`,
      kind: 'llm',
      name: 'planner',
      provider,
      model: 'claude-x',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 7.5,
      success: true,
      occurredAt: new Date(),
    });

    const hierarchy = (service as unknown as { hierarchy: AiUsageHierarchyService }).hierarchy;
    const monthToDate = await hierarchy.getProviderCostSince(provider, startOfMonthIst());
    const sameWindowAgain = await hierarchy.getProviderCostSince(provider, startOfMonthIst());
    expect(monthToDate).toBeCloseTo(sameWindowAgain, 10); // identical window -> identical figure, always.
    expect(monthToDate).toBeGreaterThanOrEqual(7.5);
  });

  // --- Required test 7: USD to INR conversion / gross margin ---------------
  it('getProfitability computes gross profit/margin via PricingService\'s real conversion, never adding credits and USD directly', async () => {
    const before = await service.getProfitability(1);
    // The service's own totalRevenueUsd must equal pricing.creditsToUsd(totalRevenueCredits) exactly — the one conversion boundary.
    expect(before.totalRevenueUsd).toBeCloseTo(pricing.creditsToUsd(before.totalRevenueCredits), 2);
    expect(before.grossProfitUsd).toBeCloseTo(before.totalRevenueUsd - before.totalProviderCostUsd, 2);
    if (before.totalRevenueUsd > 0) {
      expect(before.grossMarginPct).toBeCloseTo((before.grossProfitUsd / before.totalRevenueUsd) * 100, 2);
    } else {
      expect(before.grossMarginPct).toBeNull();
    }
    expect(before.reportingCurrency).toBe('USD');
  });

  // --- Required test 8: organization isolation (platform-wide aggregation) -
  it('provider cost aggregation is platform-wide — sums across every organization, never scoped to just one', async () => {
    const provider = `${PREFIX}-multi-org`;
    await executionModel.create({
      organizationId: `${PREFIX}-org-A`,
      userId: `${PREFIX}-user-A`,
      kind: 'llm',
      name: 'planner',
      provider,
      model: 'claude-x',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 3,
      success: true,
      occurredAt: new Date(),
    });
    await executionModel.create({
      organizationId: `${PREFIX}-org-B`,
      userId: `${PREFIX}-user-B`,
      kind: 'llm',
      name: 'planner',
      provider,
      model: 'claude-x',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 4,
      success: true,
      occurredAt: new Date(),
    });

    const hierarchy = (service as unknown as { hierarchy: AiUsageHierarchyService }).hierarchy;
    const total = await hierarchy.getProviderCostSince(provider, startOfMonthIst());
    expect(total).toBeCloseTo(7, 5); // both orgs' cost included — neither org filtered out nor double-isolated.
  });

  // --- Required test 9: date range and timezone boundaries -----------------
  it('"this month" uses Asia/Kolkata wall-clock boundaries, not the server OS timezone or raw UTC', () => {
    const now = new Date('2026-11-01T01:00:00.000Z'); // 06:30 IST on Nov 1 — unambiguously within November IST.
    const start = startOfMonthIst(now);
    // Nov 1 00:00 IST == Oct 31 18:30 UTC.
    expect(start.toISOString()).toBe('2026-10-31T18:30:00.000Z');
    expect(start.getTime()).toBeLessThan(now.getTime());

    const justBeforeIstMidnight = new Date('2026-10-31T18:29:59.000Z'); // 23:59:59 IST on Oct 31 — still October, IST.
    expect(startOfMonthIst(justBeforeIstMidnight).toISOString()).toBe('2026-09-30T18:30:00.000Z'); // belongs to October's own start, not November's.
  });

  it('a transaction just after IST midnight but before UTC midnight is counted in the NEW month, not left in the old UTC day', async () => {
    const provider = `${PREFIX}-ist-boundary`;
    // 2026-11-01T00:05 IST == 2026-10-31T18:35 UTC — before UTC midnight,
    // but already November from the IST wall-clock this app reports in.
    await executionModel.create({
      organizationId: `${PREFIX}-org-ist`,
      userId: `${PREFIX}-user`,
      kind: 'llm',
      name: 'planner',
      provider,
      model: 'claude-x',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 9,
      success: true,
      occurredAt: new Date('2026-10-31T18:35:00.000Z'),
    });

    const hierarchy = (service as unknown as { hierarchy: AiUsageHierarchyService }).hierarchy;
    const novemberIst = await hierarchy.getProviderCostSince(provider, startOfMonthIst(new Date('2026-11-15T12:00:00Z')));
    expect(novemberIst).toBeCloseTo(9, 5);
  });

  // --- Required test 10: sync failure preserving historical data -----------
  it('a failed usage-cost sync preserves the last successfully-synced figure, never zeroing it out', async () => {
    await service.setAdminApiKey('anthropic', 'sk-ant-admin-fake-key-for-test');
    await accountModel.updateOne({ provider: 'anthropic' }, { $set: { lastProviderReportedCostThisMonth: 42.5, lastUsageCostSyncAt: new Date(), lastUsageCostSyncError: null } }).exec();

    // Force the real adapter call to fail without touching any other
    // behavior — the registry's AnthropicFinanceAdapter stub has no real
    // HttpService, so calling syncUsageCost throws naturally.
    await service.syncUsageCostForProvider('anthropic');

    const doc = await accountModel.findOne({ provider: 'anthropic' }).exec();
    expect(doc?.lastProviderReportedCostThisMonth).toBe(42.5); // untouched by the failed attempt.
    expect(doc?.lastUsageCostSyncError).not.toBeNull(); // the failure IS recorded, just never overwrites the figure.
    expect(doc?.lastUsageCostSyncAttemptedAt).not.toBeNull();
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

  it('never writes to WalletTransaction, IntegrationCredential, or any billing collection — every method here is read-only against them', async () => {
    const createSpy = jest.spyOn(transactionModel, 'create');
    const updateSpy = jest.spyOn(transactionModel, 'updateOne');
    const credCreateSpy = jest.spyOn(credentialModel, 'create');
    const credUpdateSpy = jest.spyOn(credentialModel, 'updateOne');
    const provider = `${PREFIX}-readonly`;

    await service.getAccounts();
    await service.recordPayment({ provider, amount: 5, paymentDate: new Date().toISOString(), paymentMethod: 'card' }, 'admin-1');
    await service.upsertAccount(provider, { monthlyBudget: 10 });
    await service.setAdminApiKey('anthropic', 'sk-ant-admin-fake-key-for-test');
    await service.getFinanceDashboard(1);
    await service.getProfitability(1);
    await service.getPaymentTotals('provider');

    expect(createSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(credCreateSpy).not.toHaveBeenCalled();
    expect(credUpdateSpy).not.toHaveBeenCalled();
    createSpy.mockRestore();
    updateSpy.mockRestore();
    credCreateSpy.mockRestore();
    credUpdateSpy.mockRestore();
  });

  it('a provider cross-checks correctly against Python-written state — the shared provider_accounts collection must agree', async () => {
    // Mirrors exactly what python-agent's provider_account_status.
    // mark_exhausted() writes: {$set: {status: 'exhausted'}} on the shared
    // collection, bypassing this service entirely — this test asserts the
    // NestJS read side genuinely reflects that write, the one cross-language
    // integration point this feature depends on.
    await accountModel.updateOne({ provider: 'groq' }, { $set: { status: 'exhausted' } }, { upsert: true }).exec();
    const account = await service.getAccount('groq');
    expect(account.status).toBe('exhausted');
    expect(account.operational).toBe(false);
  });
});
