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
    walletModel = moduleRef.get(getModelToken(Wallet.name));
    reservationModel = moduleRef.get(getModelToken(CreditReservation.name));
    executionModel = moduleRef.get(getModelToken(AgentExecution.name));
    pricingModel = moduleRef.get(getModelToken(ProviderPricing.name));
    settingsModel = moduleRef.get(getModelToken(BillingSettings.name));
    transactionModel = moduleRef.get(getModelToken(WalletTransaction.name));
  });

  afterAll(async () => {
    await walletModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await transactionModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await reservationModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await executionModel.deleteMany({ requestId: { $regex: `^${TEST_PREFIX}` } });
    await pricingModel.deleteMany({ provider: { $regex: `^${TEST_PREFIX}` } });
    await settingsModel.deleteMany({ singletonKey: 'default' });
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
});
