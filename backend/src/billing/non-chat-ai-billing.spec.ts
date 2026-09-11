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

// Real-Mongo integration tests for the reserve/settle/release WIRING PATTERN
// now shared by 4 previously-unbilled features (Email Intelligence analysis,
// Business Knowledge document extraction, Finance/Customer-Activity "Generate
// Summary", Scheduled Reports) — each of those NestJS services now does
// exactly this: generate a requestId, call reservations.reserve() BEFORE
// calling out to python-agent, reservations.settle() on success,
// reservations.release() on failure. Rather than re-instantiating each
// feature's full (and heavy — GridFS, multiple CRM schemas, etc.) DI graph
// just to re-prove ReservationService's own already-covered behavior (see
// reservation-margin.spec.ts/billing-integration.spec.ts), this spec proves
// the actual shared contract those call sites all rely on: an org with an
// exhausted wallet gets a real 402 with no LLM call ever attempted, and a
// funded org whose "python-agent call" throws AFTER a successful reserve()
// gets its held credits released back rather than lost.
const TEST_PREFIX = `jest-nonchat-billing-${Date.now()}`;

describe('Non-chat AI features — shared reserve/settle/release wiring (real Mongo)', () => {
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
                'billing.usdToCurrencyRate': 1,
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
    await connection.close();
  });

  // Mirrors exactly what each new call site does: reserve() as a hard stop
  // BEFORE ever attempting the outbound python-agent call.
  async function attemptFeatureCall(
    organizationId: string,
    userId: string,
    requestId: string,
    label: string,
    call: () => Promise<void>,
  ) {
    await reservationService.reserve(organizationId, userId, requestId, label);
    try {
      await call();
      return await reservationService.settle(requestId);
    } catch (err) {
      await reservationService.release(requestId);
      throw err;
    }
  }

  it('an org with zero credits gets a 402 and the wrapped "python-agent call" never runs', async () => {
    const organizationId = `${TEST_PREFIX}-org-empty`;
    await walletModel.create({ organizationId, balanceCredits: 0, reservedCredits: 0 });

    const requestId = `${TEST_PREFIX}-req-empty`;
    const pythonAgentCall = jest.fn(async () => {
      throw new Error('should never be called');
    });

    await expect(
      attemptFeatureCall(organizationId, 'user-1', requestId, 'email-intelligence-analyze', pythonAgentCall),
    ).rejects.toMatchObject({ status: 402 });

    expect(pythonAgentCall).not.toHaveBeenCalled();
    const reservation = await reservationModel.findOne({ requestId }).exec();
    expect(reservation).toBeNull(); // reserve() never created a row — it failed before persisting one
  });

  it('a funded org whose python-agent call fails gets its held credits released back', async () => {
    const organizationId = `${TEST_PREFIX}-org-release`;
    await walletModel.create({ organizationId, balanceCredits: 1000, reservedCredits: 0 });

    const requestId = `${TEST_PREFIX}-req-release`;
    const pythonAgentCall = jest.fn(async () => {
      throw new Error('simulated python-agent/network failure');
    });

    await expect(
      attemptFeatureCall(organizationId, 'user-1', requestId, 'finance-summary', pythonAgentCall),
    ).rejects.toThrow('simulated python-agent/network failure');

    expect(pythonAgentCall).toHaveBeenCalledTimes(1);
    const reservation = await reservationModel.findOne({ requestId }).exec();
    expect(reservation?.status).toBe('released');
    const wallet = await walletModel.findOne({ organizationId }).exec();
    expect(wallet?.reservedCredits).toBe(0); // fully released, nothing left held
    expect(wallet?.balanceCredits).toBe(1000); // untouched — no charge for a failed call
  });

  it('a funded org whose python-agent call succeeds gets charged the real usage recorded for that requestId', async () => {
    const organizationId = `${TEST_PREFIX}-org-success`;
    await walletModel.create({ organizationId, balanceCredits: 1000, reservedCredits: 0 });
    const provider = `${TEST_PREFIX}-provider`;
    await pricingModel.create({
      provider,
      model: '*',
      inputCostPerMTokUsd: 3,
      outputCostPerMTokUsd: 15,
      effectiveFrom: new Date(Date.now() - 60_000),
      effectiveTo: null,
    });

    const requestId = `${TEST_PREFIX}-req-success`;
    // Simulates python-agent's traced_llm_call writing a real agent_executions
    // row DURING the "call" — exactly what analyze_email/analyze_customer_activity/
    // analyze_finance_activity/run_report_crew now do for their own requestId.
    const pythonAgentCall = jest.fn(async () => {
      await executionModel.create({
        organizationId,
        userId: 'user-1',
        requestId,
        kind: 'llm',
        name: 'test_call',
        provider,
        model: '*',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        success: true,
      });
    });

    const settlement = await attemptFeatureCall(organizationId, 'user-1', requestId, 'customer-activity-summary', pythonAgentCall);

    expect(pythonAgentCall).toHaveBeenCalledTimes(1);
    // costUsd = 1*3 + 1*15 = 18; customerUsd = 18 / (1-0.5) = 36; credits = 36 (1:1 rate)
    expect(settlement!.creditsCharged).toBe(36);
    const wallet = await walletModel.findOne({ organizationId }).exec();
    expect(wallet?.balanceCredits).toBe(1000 - 36);
    expect(wallet?.reservedCredits).toBe(0);
  });
});
