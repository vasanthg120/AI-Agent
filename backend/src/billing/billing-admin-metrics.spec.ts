import { ConfigService } from '@nestjs/config';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { AgentExecution, AgentExecutionSchema } from '../command-center/schemas/agent-execution.schema';
import { CommandCenterService } from '../command-center/command-center.service';
import { Organization, OrganizationSchema } from '../organizations/schemas/organization.schema';
import { User, UserSchema } from '../users/schemas/user.schema';
import { BillingAdminService } from './billing-admin.service';
import { PricingService } from './pricing.service';
import { WalletService } from './wallet.service';
import { BillingPlan, BillingPlanDocument, BillingPlanSchema } from './schemas/billing-plan.schema';
import { BillingPlanPrice, BillingPlanPriceDocument, BillingPlanPriceSchema } from './schemas/billing-plan-price.schema';
import { BillingSubscriptionEvent, BillingSubscriptionEventDocument, BillingSubscriptionEventSchema } from './schemas/billing-subscription-event.schema';
import { BillingSubscription, BillingSubscriptionDocument, BillingSubscriptionSchema } from './schemas/billing-subscription.schema';
import { Currency, CurrencyDocument, CurrencySchema } from './schemas/currency.schema';
import { PaymentRecord, PaymentRecordDocument, PaymentRecordSchema } from './schemas/payment-record.schema';
import { Wallet, WalletSchema } from './schemas/wallet.schema';
import { WalletTransaction, WalletTransactionDocument, WalletTransactionSchema } from './schemas/wallet-transaction.schema';

// Real-Mongo integration tests for Phase 7 (MRR/ARR/churn + the getOverview
// enrichment). Both methods deliberately aggregate PLATFORM-WIDE with no
// org scoping (by design — see billing-admin.service.ts's own doc
// comments), and this shared dev database has accumulated leftover
// BillingSubscription/WalletTransaction/PaymentRecord/Organization rows
// from every other spec file plus manual browser verification sessions —
// so every assertion here is a before/after DELTA across this test's own
// inserts, never an absolute count, same technique billing-invoice.spec.ts
// uses for invoice numbering against the shared global counter.

const TEST_PREFIX = `jest-billing-metrics-${Date.now()}`;

describe('BillingAdminService — Phase 7 metrics (real Mongo)', () => {
  let connection: Connection;
  let adminService: BillingAdminService;

  let planModel: Model<BillingPlanDocument>;
  let priceModel: Model<BillingPlanPriceDocument>;
  let subscriptionModel: Model<BillingSubscriptionDocument>;
  let eventModel: Model<BillingSubscriptionEventDocument>;
  let currencyModel: Model<CurrencyDocument>;
  let transactionModel: Model<WalletTransactionDocument>;
  let paymentRecordModel: Model<PaymentRecordDocument>;

  const createdPlanIds: string[] = [];
  const createdCurrencyCodes: string[] = [];

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const configValues: Record<string, unknown> = {
      'billing.creditValueInCurrency': 1,
      'billing.targetGrossMargin': 0.5,
      'billing.currency': 'INR',
      'billing.usdToCurrencyRate': 83,
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: WalletTransaction.name, schema: WalletTransactionSchema },
          { name: PaymentRecord.name, schema: PaymentRecordSchema },
          { name: AgentExecution.name, schema: AgentExecutionSchema },
          { name: Organization.name, schema: OrganizationSchema },
          { name: BillingSubscription.name, schema: BillingSubscriptionSchema },
          { name: BillingSubscriptionEvent.name, schema: BillingSubscriptionEventSchema },
          { name: BillingPlanPrice.name, schema: BillingPlanPriceSchema },
          { name: BillingPlan.name, schema: BillingPlanSchema },
          { name: Currency.name, schema: CurrencySchema },
          { name: Wallet.name, schema: WalletSchema },
          { name: User.name, schema: UserSchema },
        ]),
      ],
      providers: [
        BillingAdminService,
        CommandCenterService,
        PricingService,
        WalletService,
        { provide: ConfigService, useValue: { get: (key: string) => configValues[key] } },
      ],
    }).compile();

    connection = moduleRef.get(getModelToken(BillingSubscription.name)).db;
    adminService = moduleRef.get(BillingAdminService);

    planModel = moduleRef.get(getModelToken(BillingPlan.name));
    priceModel = moduleRef.get(getModelToken(BillingPlanPrice.name));
    subscriptionModel = moduleRef.get(getModelToken(BillingSubscription.name));
    eventModel = moduleRef.get(getModelToken(BillingSubscriptionEvent.name));
    currencyModel = moduleRef.get(getModelToken(Currency.name));
    transactionModel = moduleRef.get(getModelToken(WalletTransaction.name));
    paymentRecordModel = moduleRef.get(getModelToken(PaymentRecord.name));
  });

  afterAll(async () => {
    await planModel.deleteMany({ _id: { $in: createdPlanIds } });
    await priceModel.deleteMany({ planId: { $in: createdPlanIds } });
    await subscriptionModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await eventModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await currencyModel.deleteMany({ code: { $in: createdCurrencyCodes } });
    await transactionModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await paymentRecordModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await connection.close();
  });

  describe('getSubscriptionMetrics', () => {
    it('computes MRR across multiple currencies/cycles, normalizes to monthly USD, and counts by status', async () => {
      // Two Currency rows this test owns exclusively (unique codes), so the
      // rate lookup can't collide with any other suite's Currency data.
      const inrCode = `T${Date.now().toString().slice(-6)}I`;
      const usdCode = `T${Date.now().toString().slice(-6)}U`;
      await currencyModel.create({ code: inrCode, name: 'Test INR', symbol: '₹', usdToCurrencyRate: 83 });
      await currencyModel.create({ code: usdCode, name: 'Test USD', symbol: '$', usdToCurrencyRate: 1 });
      createdCurrencyCodes.push(inrCode, usdCode);

      const plan = await planModel.create({ key: `${TEST_PREFIX}-plan`, name: 'Metrics Plan', active: true, isPublic: true, sortOrder: 0 });
      createdPlanIds.push(plan._id.toString());

      // $10/mo equivalent via INR/monthly (830 INR / 83 = $10).
      const priceMonthlyInr = await priceModel.create({
        planId: plan._id.toString(),
        currencyCode: inrCode,
        billingCycle: 'monthly',
        amount: 830,
        creditsGranted: 1000,
        effectiveFrom: new Date(),
        effectiveTo: null,
        active: true,
      });
      // $10/mo equivalent via USD/yearly (120 USD / 12 = $10/mo).
      const priceYearlyUsd = await priceModel.create({
        planId: plan._id.toString(),
        currencyCode: usdCode,
        billingCycle: 'yearly',
        amount: 120,
        creditsGranted: 5000,
        effectiveFrom: new Date(),
        effectiveTo: null,
        active: true,
      });

      const before = await adminService.getSubscriptionMetrics(3650); // wide window to safely include this test's own 'created' events

      const now = new Date();
      const farFuture = new Date(Date.now() + 30 * 86_400_000);
      await subscriptionModel.create({
        organizationId: `${TEST_PREFIX}-org-active-1`,
        planId: plan._id.toString(),
        planPriceId: priceMonthlyInr._id.toString(),
        status: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: farFuture,
        createdBy: 'user-1',
      });
      await subscriptionModel.create({
        organizationId: `${TEST_PREFIX}-org-active-2`,
        planId: plan._id.toString(),
        planPriceId: priceYearlyUsd._id.toString(),
        status: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: farFuture,
        createdBy: 'user-1',
      });
      await subscriptionModel.create({
        organizationId: `${TEST_PREFIX}-org-trialing`,
        planId: plan._id.toString(),
        planPriceId: priceMonthlyInr._id.toString(),
        status: 'trialing',
        currentPeriodStart: now,
        currentPeriodEnd: farFuture,
        createdBy: 'user-1',
      });
      await subscriptionModel.create({
        organizationId: `${TEST_PREFIX}-org-canceled`,
        planId: plan._id.toString(),
        planPriceId: priceMonthlyInr._id.toString(),
        status: 'canceled',
        currentPeriodStart: now,
        currentPeriodEnd: farFuture,
        createdBy: 'user-1',
      });
      await eventModel.create({ subscriptionId: 'fake-sub-1', organizationId: `${TEST_PREFIX}-org-active-1`, type: 'created' });
      await eventModel.create({ subscriptionId: 'fake-sub-2', organizationId: `${TEST_PREFIX}-org-active-2`, type: 'created' });
      await eventModel.create({ subscriptionId: 'fake-sub-3', organizationId: `${TEST_PREFIX}-org-canceled`, type: 'canceled' });

      const after = await adminService.getSubscriptionMetrics(3650);

      // $10 + $10 = $20/mo contributed by this test's two active subscriptions.
      expect(Math.round((after.mrrUsd - before.mrrUsd) * 100) / 100).toBeCloseTo(20, 2);
      expect(Math.round((after.arrUsd - before.arrUsd) * 100) / 100).toBeCloseTo(240, 2);
      expect(after.activeCount - before.activeCount).toBe(2);
      expect(after.trialingCount - before.trialingCount).toBe(1);
      expect(after.canceledCount - before.canceledCount).toBe(1);
      expect(after.newSubscriptionsInPeriod - before.newSubscriptionsInPeriod).toBe(2);
      expect(after.canceledInPeriod - before.canceledInPeriod).toBe(1);
    });
  });

  describe('getOverview — Phase 6 refunds/failed-payments enrichment', () => {
    it('includes refundedUsd/refundsCount/failedPaymentsCount/totalCustomers deltas', async () => {
      const org = `${TEST_PREFIX}-org-overview`;
      const before = await adminService.getOverview(3650);

      // A REFUND ledger row worth 415 credits -> $5 at the default 83 rate
      // (matches RefundService's own writer shape: negative amountCredits).
      await transactionModel.create({
        organizationId: org,
        walletId: 'fake-wallet',
        type: 'REFUND',
        amountCredits: -415,
        balanceAfterCredits: 0,
        createdBy: 'admin-1',
      });
      await paymentRecordModel.create({
        organizationId: org,
        walletId: 'fake-wallet',
        type: 'purchase',
        provider: 'razorpay',
        gatewayOrderId: `${TEST_PREFIX}-failed-order`,
        amount: 100,
        currency: 'INR',
        creditsGranted: 0,
        status: 'failed',
      });

      const after = await adminService.getOverview(3650);
      expect(after.refundsCount - before.refundsCount).toBe(1);
      expect(Math.round((after.refundedUsd - before.refundedUsd) * 100) / 100).toBeCloseTo(5, 2);
      expect(after.failedPaymentsCount - before.failedPaymentsCount).toBe(1);
      expect(after.totalCustomers).toBeGreaterThanOrEqual(before.totalCustomers); // never shrinks
    });
  });
});
