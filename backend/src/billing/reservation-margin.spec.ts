import { ConfigService } from '@nestjs/config';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { AgentExecution, AgentExecutionDocument, AgentExecutionSchema } from '../command-center/schemas/agent-execution.schema';
import { AutoPayService } from './autopay.service';
import { PricingService } from './pricing.service';
import { ReservationService } from './reservation.service';
import { WalletService } from './wallet.service';
import { BillingSettings, BillingSettingsDocument, BillingSettingsSchema } from './schemas/billing-settings.schema';
import { CreditReservation, CreditReservationDocument, CreditReservationSchema } from './schemas/credit-reservation.schema';
import { ProviderPricing, ProviderPricingDocument, ProviderPricingSchema } from './schemas/provider-pricing.schema';
import { Wallet, WalletDocument, WalletSchema } from './schemas/wallet.schema';
import { WalletTransaction, WalletTransactionDocument, WalletTransactionSchema } from './schemas/wallet-transaction.schema';

// Real-Mongo integration tests for ReservationService.settle()'s dynamic
// margin behavior (spec TEST 8/9/10/11) — the one thing this billing pass
// actually changed about settlement: per-usage-group margin resolution
// (global BillingSettings override, or a ProviderPricing.marginOverridePct
// override), replacing the old "sum cost across every group, apply one
// margin" approach. reserve()'s Auto Recharge path is untouched by this
// pass and is out of scope here — AutoPayService is stubbed out since
// settle()/release() never call it.

const TEST_PREFIX = `jest-reservation-margin-${Date.now()}`;

describe('ReservationService.settle — dynamic margin (real Mongo)', () => {
  let connection: Connection;
  let reservationService: ReservationService;
  let walletService: WalletService;
  let pricingService: PricingService;
  let walletModel: Model<WalletDocument>;
  let reservationModel: Model<CreditReservationDocument>;
  let executionModel: Model<AgentExecutionDocument>;
  let pricingModel: Model<ProviderPricingDocument>;
  let settingsModel: Model<BillingSettingsDocument>;
  let transactionModel: Model<WalletTransactionDocument>;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Wallet.name, schema: WalletSchema },
          { name: WalletTransaction.name, schema: WalletTransactionSchema },
          { name: CreditReservation.name, schema: CreditReservationSchema },
          { name: ProviderPricing.name, schema: ProviderPricingSchema },
          { name: AgentExecution.name, schema: AgentExecutionSchema },
          { name: BillingSettings.name, schema: BillingSettingsSchema },
        ]),
      ],
      providers: [
        ReservationService,
        WalletService,
        PricingService,
        { provide: AutoPayService, useValue: { attemptRecharge: async () => false } },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              ({
                'billing.reservationCeilingCredits': 500,
                'billing.reservationTimeoutMinutes': 10,
                'billing.lowBalanceThresholdCredits': 200,
                'billing.creditValueInCurrency': 1,
                'billing.targetGrossMargin': 0.5,
                'billing.currency': 'INR',
                'billing.usdToCurrencyRate': 1, // 1:1 so credits == USD, easy assertions
                'billing.autoRechargeDefault': false,
                'billing.freeTrialCredits': 0,
              })[key],
          },
        },
      ],
    }).compile();

    connection = moduleRef.get(getModelToken(Wallet.name)).db;
    reservationService = moduleRef.get(ReservationService);
    walletService = moduleRef.get(WalletService);
    pricingService = moduleRef.get(PricingService);
    walletModel = moduleRef.get(getModelToken(Wallet.name));
    reservationModel = moduleRef.get(getModelToken(CreditReservation.name));
    executionModel = moduleRef.get(getModelToken(AgentExecution.name));
    pricingModel = moduleRef.get(getModelToken(ProviderPricing.name));
    settingsModel = moduleRef.get(getModelToken(BillingSettings.name));
    transactionModel = moduleRef.get(getModelToken(WalletTransaction.name));
  });

  let settingsBefore: Record<string, unknown> | null = null;
  beforeAll(async () => {
    settingsBefore = await settingsModel.collection.findOne({ singletonKey: 'default' });
  });

  afterAll(async () => {
    await walletModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await transactionModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await reservationModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await executionModel.deleteMany({ requestId: { $regex: `^${TEST_PREFIX}` } });
    await pricingModel.deleteMany({ provider: { $regex: `^${TEST_PREFIX}` } });
    // The billing settings are the app's one shared document: put back exactly what was there.
    if (settingsBefore) await settingsModel.collection.replaceOne({ singletonKey: 'default' }, settingsBefore, { upsert: true });
    else await settingsModel.deleteMany({ singletonKey: 'default' });
    await connection.close();
  });

  // Idempotent per organizationId — Wallet.organizationId is uniquely
  // indexed, and TEST 10 deliberately calls this twice for the SAME org (two
  // reservations settled before/after an admin margin change), so a second
  // call tops up reservedCredits on the existing wallet instead of trying to
  // insert a duplicate.
  async function seedReservation(organizationId: string, requestId: string, estimatedCredits = 500) {
    const wallet = await walletModel.findOneAndUpdate(
      { organizationId },
      { $setOnInsert: { organizationId, balanceCredits: 10_000 }, $inc: { reservedCredits: estimatedCredits } },
      { upsert: true, new: true },
    );
    await reservationModel.create({
      organizationId,
      walletId: wallet._id.toString(),
      requestId,
      conversationId: `${requestId}-conv`,
      userId: `${requestId}-user`,
      estimatedCredits,
      status: 'pending',
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    return wallet;
  }

  it('TEST 8: provider cost $1, 50% margin (default) -> customer charge $2 (== 2 credits at a 1:1 peg)', async () => {
    const org = `${TEST_PREFIX}-t8`;
    const requestId = `${TEST_PREFIX}-t8-req`;
    // A fake, never-seeded provider name — resolvePricing() finds no
    // ProviderPricing row for it, so settle() falls back to this row's own
    // costUsd exactly as written, rather than recomputing cost from
    // inputTokens/outputTokens against a real seeded rate (e.g. the real
    // 'anthropic' provider already has a day-0 seeded row).
    const provider = `${TEST_PREFIX}-t8-provider`;
    await seedReservation(org, requestId);
    await executionModel.create({ organizationId: org, requestId, kind: 'llm', provider, model: 'claude-x', costUsd: 1, occurredAt: new Date() });

    const result = await reservationService.settle(requestId);
    expect(result.creditsCharged).toBeCloseTo(2, 10);
  });

  it('TEST 9: provider cost $1, 70% explicit ProviderPricing override -> customer charge ≈ $3.333333', async () => {
    const org = `${TEST_PREFIX}-t9`;
    const requestId = `${TEST_PREFIX}-t9-req`;
    const provider = `${TEST_PREFIX}-provider-70`;
    await seedReservation(org, requestId);
    await pricingModel.create({
      provider,
      model: '*',
      inputCostPerMTokUsd: 1,
      outputCostPerMTokUsd: 1,
      marginOverridePct: 70,
      effectiveFrom: new Date(Date.now() - 60_000),
      effectiveTo: null,
    });
    // 1,000,000 input tokens at $1/MTok == exactly $1 provider cost.
    await executionModel.create({ organizationId: org, requestId, kind: 'llm', provider, model: 'any-model', inputTokens: 1_000_000, outputTokens: 0, costUsd: 1, occurredAt: new Date() });

    const result = await reservationService.settle(requestId);
    expect(result.creditsCharged).toBeCloseTo(3.3333333333, 2);
  });

  it('TEST 10: admin changes the global margin from 50% to 70% -> only FUTURE settlements use it; already-settled transactions are untouched', async () => {
    const org = `${TEST_PREFIX}-t10`;
    const requestIdBefore = `${TEST_PREFIX}-t10-before`;
    const requestIdAfter = `${TEST_PREFIX}-t10-after`;
    const provider = `${TEST_PREFIX}-t10-provider`; // fake, never-seeded — see TEST 8's comment

    // First turn, settled under the 50% default (no admin override yet).
    await seedReservation(org, requestIdBefore);
    await executionModel.create({ organizationId: org, requestId: requestIdBefore, kind: 'llm', provider, model: 'claude-x', costUsd: 1, occurredAt: new Date() });
    const before = await reservationService.settle(requestIdBefore);
    expect(before.creditsCharged).toBeCloseTo(2, 10); // 50% margin

    // Admin now sets the global margin to 70%.
    await settingsModel.findOneAndUpdate({ singletonKey: 'default' }, { $set: { singletonKey: 'default', targetGrossMarginPct: 70 } }, { upsert: true }).exec();

    // Second turn, settled AFTER the change, must use 70%.
    await seedReservation(org, requestIdAfter);
    await executionModel.create({ organizationId: org, requestId: requestIdAfter, kind: 'llm', provider, model: 'claude-x', costUsd: 1, occurredAt: new Date() });
    const after = await reservationService.settle(requestIdAfter);
    expect(after.creditsCharged).toBeCloseTo(3.3333333333, 2); // 70% margin

    // The FIRST (already-settled) reservation's stored amount must be unchanged.
    const firstReservation = await reservationModel.findOne({ requestId: requestIdBefore }).exec();
    expect(firstReservation?.settledCredits).toBeCloseTo(2, 10);

    // Reset the global override so it doesn't leak into other tests in this file.
    await settingsModel.updateOne({ singletonKey: 'default' }, { $unset: { targetGrossMarginPct: '' } }).exec();
  });

  it('TEST 11: two different providers in the same turn each resolve their OWN ProviderPricing entry and margin, summed correctly', async () => {
    const org = `${TEST_PREFIX}-t11`;
    const requestId = `${TEST_PREFIX}-t11-req`;
    const providerA = `${TEST_PREFIX}-provider-a`; // global margin (50%)
    const providerB = `${TEST_PREFIX}-provider-b`; // explicit override (70%)
    await seedReservation(org, requestId);

    await pricingModel.create({ provider: providerA, model: '*', inputCostPerMTokUsd: 1, outputCostPerMTokUsd: 1, effectiveFrom: new Date(Date.now() - 60_000), effectiveTo: null });
    await pricingModel.create({ provider: providerB, model: '*', inputCostPerMTokUsd: 1, outputCostPerMTokUsd: 1, marginOverridePct: 70, effectiveFrom: new Date(Date.now() - 60_000), effectiveTo: null });

    // $1 cost from provider A (50% margin -> $2) + $1 cost from provider B (70% margin -> $3.333...) = $5.333...
    await executionModel.create({ organizationId: org, requestId, kind: 'llm', provider: providerA, model: 'model-a', inputTokens: 1_000_000, outputTokens: 0, costUsd: 1, occurredAt: new Date() });
    await executionModel.create({ organizationId: org, requestId, kind: 'llm', provider: providerB, model: 'model-b', inputTokens: 1_000_000, outputTokens: 0, costUsd: 1, occurredAt: new Date() });

    const result = await reservationService.settle(requestId);
    expect(result.creditsCharged).toBeCloseTo(5.3333333333, 2);
  });

  it('settle() is idempotent — retrying returns the same already-settled amount, never double-charges', async () => {
    const org = `${TEST_PREFIX}-idem`;
    const requestId = `${TEST_PREFIX}-idem-req`;
    const provider = `${TEST_PREFIX}-idem-provider`; // fake, never-seeded — see TEST 8's comment
    const wallet = await seedReservation(org, requestId);
    await executionModel.create({ organizationId: org, requestId, kind: 'llm', provider, model: 'claude-x', costUsd: 1, occurredAt: new Date() });

    const first = await reservationService.settle(requestId);
    expect(first.creditsCharged).toBeCloseTo(2, 10); // sanity check — not a degenerate zero-charge settlement
    const second = await reservationService.settle(requestId);
    expect(second.creditsCharged).toBe(first.creditsCharged);

    const finalWallet = await walletModel.findById(wallet._id).exec();
    // Only ONE AI_USAGE debit should have happened — balance dropped by
    // creditsCharged exactly once, not twice.
    expect(finalWallet!.balanceCredits).toBe(10_000 - first.creditsCharged);
  });

  it('settle() called genuinely concurrently for the same requestId never double-debits the wallet', async () => {
    const org = `${TEST_PREFIX}-concurrent`;
    const requestId = `${TEST_PREFIX}-concurrent-req`;
    const provider = `${TEST_PREFIX}-concurrent-provider`; // fake, never-seeded — see TEST 8's comment
    const wallet = await seedReservation(org, requestId);
    await executionModel.create({ organizationId: org, requestId, kind: 'llm', provider, model: 'claude-x', costUsd: 1, occurredAt: new Date() });

    // Unlike the sequential idempotent-retry test above (one call finishes
    // before the next starts), this fires both at once — the exact race the
    // atomic pending->settled claim in settle() guards against. Without it,
    // both calls could read status:'pending' before either writes and both
    // would call wallet.settleUsage(), debiting twice.
    const [first, second] = await Promise.all([reservationService.settle(requestId), reservationService.settle(requestId)]);
    expect(first.creditsCharged).toBeCloseTo(2, 10);
    expect(second.creditsCharged).toBeCloseTo(2, 10);

    const finalWallet = await walletModel.findById(wallet._id).exec();
    expect(finalWallet!.balanceCredits).toBe(10_000 - first.creditsCharged);

    // recordUsageTransaction stores the chat turn's requestId under the
    // WalletTransaction's `reservationId` field (see wallet.service.ts's
    // own positional-arg naming) — not `requestId`.
    const transactionCount = await transactionModel.countDocuments({ organizationId: org, reservationId: requestId });
    expect(transactionCount).toBe(1);
  });

  it('a failure BEFORE the wallet debit (Phase 1) reverts the claim to pending — retry succeeds and the wallet is debited exactly once', async () => {
    const org = `${TEST_PREFIX}-fail-pre-debit`;
    const requestId = `${TEST_PREFIX}-fail-pre-debit-req`;
    const provider = `${TEST_PREFIX}-fail-pre-debit-provider`;
    const wallet = await seedReservation(org, requestId);
    await executionModel.create({ organizationId: org, requestId, kind: 'llm', provider, model: 'claude-x', costUsd: 1, occurredAt: new Date() });

    const pricingSpy = jest.spyOn(pricingService, 'providerCostToCustomerCredits').mockRejectedValueOnce(new Error('simulated pricing failure'));

    // First attempt fails inside Phase 1 (before wallet.settleUsage ever
    // runs) — settle() must rethrow (so the caller/python-agent knows this
    // turn wasn't actually charged) rather than silently swallowing it.
    await expect(reservationService.settle(requestId)).rejects.toThrow('simulated pricing failure');

    // The claim must have been reverted, not left stuck at 'settling'.
    const afterFailure = await reservationModel.findOne({ requestId }).exec();
    expect(afterFailure?.status).toBe('pending');
    expect(afterFailure?.settlingAt).toBeUndefined();
    // Nothing was debited by the failed attempt.
    const walletAfterFailure = await walletModel.findById(wallet._id).exec();
    expect(walletAfterFailure!.balanceCredits).toBe(10_000);

    pricingSpy.mockRestore();

    // A real retry (the mock is gone now) must succeed and charge exactly once.
    const result = await reservationService.settle(requestId);
    expect(result.creditsCharged).toBeCloseTo(2, 10);

    const finalWallet = await walletModel.findById(wallet._id).exec();
    expect(finalWallet!.balanceCredits).toBe(10_000 - result.creditsCharged);
    const transactionCount = await transactionModel.countDocuments({ organizationId: org, reservationId: requestId });
    expect(transactionCount).toBe(1);
  });

  it('a failure AFTER the wallet debit (Phase 2, recordUsageTransaction) still reports the real charge and reaches settled — never reverts, never re-debits on a later call', async () => {
    const org = `${TEST_PREFIX}-fail-post-debit`;
    const requestId = `${TEST_PREFIX}-fail-post-debit-req`;
    const provider = `${TEST_PREFIX}-fail-post-debit-provider`;
    const wallet = await seedReservation(org, requestId);
    await executionModel.create({ organizationId: org, requestId, kind: 'llm', provider, model: 'claude-x', costUsd: 1, occurredAt: new Date() });

    const txSpy = jest.spyOn(walletService, 'recordUsageTransaction').mockRejectedValueOnce(new Error('simulated audit-log write failure'));

    // Phase 2 failures are logged, never thrown — the real charge already
    // happened in Phase 1 and must be reported correctly regardless.
    const result = await reservationService.settle(requestId);
    expect(result.creditsCharged).toBeCloseTo(2, 10);

    const reservation = await reservationModel.findOne({ requestId }).exec();
    expect(reservation?.status).toBe('settled');
    expect(reservation?.settledCredits).toBeCloseTo(2, 10);

    // The wallet was debited exactly once despite the downstream failure —
    // and the missing WalletTransaction row (the one, acceptable gap this
    // design accepts) is confirmed absent rather than assumed.
    const finalWallet = await walletModel.findById(wallet._id).exec();
    expect(finalWallet!.balanceCredits).toBe(10_000 - result.creditsCharged);
    const transactionCount = await transactionModel.countDocuments({ organizationId: org, reservationId: requestId });
    expect(transactionCount).toBe(0);

    txSpy.mockRestore();

    // A later call for the same requestId must hit the idempotent
    // 'settled' check at the top of settle() — never redo Phase 1, never
    // re-debit — even though recordUsageTransaction never succeeded.
    const second = await reservationService.settle(requestId);
    expect(second.creditsCharged).toBeCloseTo(2, 10);
    const walletAfterRetry = await walletModel.findById(wallet._id).exec();
    expect(walletAfterRetry!.balanceCredits).toBe(10_000 - result.creditsCharged);
  });

  it('release() on AI execution failure never charges usage', async () => {
    const org = `${TEST_PREFIX}-release`;
    const requestId = `${TEST_PREFIX}-release-req`;
    const wallet = await seedReservation(org, requestId, 500);

    const result = await reservationService.release(requestId);
    expect(result.released).toBe(true);

    const finalWallet = await walletModel.findById(wallet._id).exec();
    expect(finalWallet!.balanceCredits).toBe(10_000); // untouched
    expect(finalWallet!.reservedCredits).toBe(0); // released back

    const reservation = await reservationModel.findOne({ requestId }).exec();
    expect(reservation?.status).toBe('released');
  });

  // A request holds at most the ceiling (500 in this spec) — and when the wallet
  // has less than that, whatever is there. "Exhausted" means nothing is left,
  // not "less than the ceiling": a 500-credit plan used once must keep working.
  describe('reserve — a wallet with credits in it can spend them', () => {
    const walletWith = (key: string, balanceCredits: number) => walletModel.create({ organizationId: `${TEST_PREFIX}-${key}`, balanceCredits, reservedCredits: 0 });

    it('holds what is left when that is less than the ceiling', async () => {
      await walletWith('partial', 497.88);
      const result = await reservationService.reserve(`${TEST_PREFIX}-partial`, 'user-1', `${TEST_PREFIX}-partial-req`, 'conv');
      expect(result.estimatedCredits).toBe(497.88);
      expect(await walletModel.findOne({ organizationId: `${TEST_PREFIX}-partial` })).toMatchObject({ balanceCredits: 497.88, reservedCredits: 497.88 });
      // Releasing gives back exactly what was held.
      await reservationService.release(`${TEST_PREFIX}-partial-req`);
      expect((await walletModel.findOne({ organizationId: `${TEST_PREFIX}-partial` }))!.reservedCredits).toBeCloseTo(0, 5);
    });

    it('holds only the ceiling when more than that is available', async () => {
      await walletWith('full', 2000);
      const result = await reservationService.reserve(`${TEST_PREFIX}-full`, 'user-1', `${TEST_PREFIX}-full-req`, 'conv');
      expect(result.estimatedCredits).toBe(500);
      expect(result.availableCredits).toBe(1500);
    });

    it('refuses only a wallet with nothing left', async () => {
      await walletWith('empty', 0);
      await expect(reservationService.reserve(`${TEST_PREFIX}-empty`, 'user-1', `${TEST_PREFIX}-empty-req`, 'conv')).rejects.toMatchObject({ status: 402 });
      await walletWith('held', 10);
      await reservationService.reserve(`${TEST_PREFIX}-held`, 'user-1', `${TEST_PREFIX}-held-req-1`, 'conv');
      // Everything is held by the first request while it runs.
      await expect(reservationService.reserve(`${TEST_PREFIX}-held`, 'user-1', `${TEST_PREFIX}-held-req-2`, 'conv')).rejects.toMatchObject({ status: 402 });
    });
  });
});
