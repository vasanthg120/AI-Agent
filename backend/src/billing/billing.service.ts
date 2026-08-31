import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BillingInvoiceService } from './billing-invoice.service';
import { CouponsService } from './coupons.service';
import { PAYMENT_PROVIDER, PaymentProviderAdapter } from './providers/payment-provider.interface';
import { WalletService, WalletSummary } from './wallet.service';
import { CreditPackage, CreditPackageDocument } from './schemas/credit-package.schema';
import { PaymentMethod, PaymentMethodDocument } from './schemas/payment-method.schema';
import { PaymentRecord, PaymentRecordDocument } from './schemas/payment-record.schema';
import { WalletTransaction, WalletTransactionDocument, WalletTransactionType } from './schemas/wallet-transaction.schema';

export interface CustomerTransaction {
  id: string;
  type: WalletTransactionType;
  amountCredits: number;
  balanceAfterCredits: number;
  createdAt: Date;
  description: string;
  // Only populated for AI_USAGE rows — non-identifying token totals (see
  // "Haive Input/Output/Total Tokens" in the spec) are customer-facing,
  // unlike everything else this domain tracks about a chat turn's cost.
  inputTokens?: number;
  outputTokens?: number;
}

export interface UsageSummary {
  availableCredits: number;
  creditsUsedTotal: number;
  totalPurchasedCredits: number;
  aiRequestCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  usageTodayCredits: number;
  usageThisMonthCredits: number;
}

const TRANSACTION_DESCRIPTIONS: Record<WalletTransactionType, string> = {
  FREE_TRIAL: 'Free trial credits',
  PURCHASE: 'Credit purchase',
  AI_USAGE: 'Haive AI usage',
  AUTO_RECHARGE: 'Auto Recharge',
  BONUS: 'Bonus credits',
  PROMOTION: 'Promotional credits',
  REFUND: 'Refund',
  MANUAL_ADJUSTMENT: 'Manual adjustment',
  SUBSCRIPTION_GRANT: 'Subscription credits',
};

export interface AutoRechargePolicy {
  minCredits?: number;
  maxCredits?: number;
  defaultOn: boolean;
  currency: string;
}

export interface InitiatePurchaseResult {
  paymentRecordId: string;
  orderId: string;
  checkoutParams: Record<string, unknown>;
  simulated: boolean;
  creditedImmediately: boolean;
  wallet?: WalletSummary;
}

/**
 * Customer-facing billing operations — wallet summary, credit packages,
 * purchases, and saved payment methods. Everything here returns only
 * Haive terminology (credits/usage/packages); never a provider name, model,
 * or provider cost — see billing.controller.ts's routes for the boundary.
 */
@Injectable()
export class BillingService {
  constructor(
    @InjectModel(CreditPackage.name) private packageModel: Model<CreditPackageDocument>,
    @InjectModel(PaymentMethod.name) private paymentMethodModel: Model<PaymentMethodDocument>,
    @InjectModel(PaymentRecord.name) private paymentRecordModel: Model<PaymentRecordDocument>,
    @InjectModel(WalletTransaction.name) private transactionModel: Model<WalletTransactionDocument>,
    @Inject(PAYMENT_PROVIDER) private paymentProvider: PaymentProviderAdapter,
    private wallet: WalletService,
    private coupons: CouponsService,
    private invoices: BillingInvoiceService,
    private config: ConfigService,
  ) {}

  /** Extends WalletService.getSummary's plain balance/reserved/autoPay
   * shape with a customer-safe subset of the admin-configured Auto Recharge
   * policy — only the four fields the Billing page's Auto Recharge tab
   * needs to display, never the full BillingSettings document (which also
   * carries company/invoice fields that stay admin-only). Deliberately only
   * merged in here (the customer-facing GET /billing/wallet wrapper), not
   * on WalletService.getSummary itself — that method is also called from
   * reserve()/settle()'s hot chat-turn path, which has no use for this and
   * shouldn't pay for an extra BillingSettings read on every turn. The
   * customer can SEE these values but never sets them from this route —
   * only AutoPayService.attemptRecharge and the admin settings route ever
   * write them. */
  async getWalletSummary(organizationId: string): Promise<WalletSummary & { autoRechargePolicy: AutoRechargePolicy }> {
    const defaultThreshold = this.config.get<number>('billing.lowBalanceThresholdCredits') ?? 200;
    const [summary, settings] = await Promise.all([this.wallet.getSummary(organizationId, defaultThreshold), this.invoices.getOrCreateSettings()]);
    return {
      ...summary,
      autoRechargePolicy: {
        minCredits: settings.autoRechargeMinCredits,
        maxCredits: settings.autoRechargeMaxCredits,
        defaultOn: settings.autoRechargeDefaultOn,
        currency: this.config.get<string>('billing.currency') ?? 'INR',
      },
    };
  }

  listPackages() {
    return this.packageModel.find({ active: true }).sort({ sortOrder: 1 }).exec();
  }

  /** Customer-safe transaction history — deliberately strips
   * WalletTransaction.metadata (which carries providerCostUsd/byProvider
   * for AI_USAGE rows, used only by billing-admin.service.ts) before this
   * ever leaves the server. This is the actual enforcement point for "the
   * customer only sees Haive Credits, never provider cost" — not a
   * frontend hide. */
  async listCustomerTransactions(organizationId: string, limit?: number): Promise<CustomerTransaction[]> {
    const rows = await this.wallet.listTransactions(organizationId, limit);
    return rows.map((row: WalletTransactionDocument) => ({
      id: row._id.toString(),
      type: row.type,
      amountCredits: row.amountCredits,
      balanceAfterCredits: row.balanceAfterCredits,
      createdAt: (row as unknown as { createdAt: Date }).createdAt,
      description: TRANSACTION_DESCRIPTIONS[row.type],
      inputTokens: row.type === 'AI_USAGE' ? (row.metadata.totalInputTokens as number | undefined) : undefined,
      outputTokens: row.type === 'AI_USAGE' ? (row.metadata.totalOutputTokens as number | undefined) : undefined,
    }));
  }

  /** Powers the customer Command Center's stat tiles — Haive Credits/
   * Requests/Tokens only, no provider identity anywhere in this
   * aggregation (it only ever reads amountCredits and the two
   * non-identifying token totals from AI_USAGE metadata). */
  async getUsageSummary(organizationId: string): Promise<UsageSummary> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(startOfDay.getFullYear(), startOfDay.getMonth(), 1);

    const [usageRows, purchaseRows, todayRows, monthRows, walletSummary] = await Promise.all([
      this.transactionModel
        .aggregate<{ credits: number; count: number; inputTokens: number; outputTokens: number }>([
          { $match: { organizationId, type: 'AI_USAGE' } },
          {
            $group: {
              _id: null,
              credits: { $sum: { $abs: '$amountCredits' } },
              count: { $sum: 1 },
              inputTokens: { $sum: { $ifNull: ['$metadata.totalInputTokens', 0] } },
              outputTokens: { $sum: { $ifNull: ['$metadata.totalOutputTokens', 0] } },
            },
          },
        ])
        .exec(),
      this.transactionModel
        .aggregate<{ credits: number }>([
          { $match: { organizationId, type: { $in: ['PURCHASE', 'AUTO_RECHARGE', 'BONUS', 'PROMOTION'] } } },
          { $group: { _id: null, credits: { $sum: '$amountCredits' } } },
        ])
        .exec(),
      this.transactionModel
        .aggregate<{ credits: number }>([
          { $match: { organizationId, type: 'AI_USAGE', createdAt: { $gte: startOfDay } } },
          { $group: { _id: null, credits: { $sum: { $abs: '$amountCredits' } } } },
        ])
        .exec(),
      this.transactionModel
        .aggregate<{ credits: number }>([
          { $match: { organizationId, type: 'AI_USAGE', createdAt: { $gte: startOfMonth } } },
          { $group: { _id: null, credits: { $sum: { $abs: '$amountCredits' } } } },
        ])
        .exec(),
      this.getWalletSummary(organizationId),
    ]);

    const usage = usageRows[0] ?? { credits: 0, count: 0, inputTokens: 0, outputTokens: 0 };
    return {
      availableCredits: walletSummary.availableCredits,
      creditsUsedTotal: usage.credits,
      totalPurchasedCredits: purchaseRows[0]?.credits ?? 0,
      aiRequestCount: usage.count,
      totalInputTokens: usage.inputTokens,
      totalOutputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
      usageTodayCredits: todayRows[0]?.credits ?? 0,
      usageThisMonthCredits: monthRows[0]?.credits ?? 0,
    };
  }

  listPaymentMethods(organizationId: string) {
    return this.paymentMethodModel.find({ organizationId }).sort({ createdAt: -1 }).exec();
  }

  /** Creates a checkout order for a credit package. Purchases must be
   * confirmed by a verified payment event before credits are permanently
   * granted — in "simulated" mode (no active-gateway keys configured) there
   * is no real webhook that will ever arrive, so the adapter's own
   * simulated success is treated as that confirmation and the wallet is
   * credited synchronously, in this same request. Once real keys are
   * configured, createCheckoutOrder returns simulated:false and crediting
   * happens exclusively from the verified webhook
   * (billing-webhook.controller.ts) — the client-side checkout callback is
   * never trusted on its own. */
  async initiatePurchase(organizationId: string, userId: string, packageKey: string, couponCode?: string): Promise<InitiatePurchaseResult> {
    const pkg = await this.packageModel.findOne({ key: packageKey, active: true });
    if (!pkg) throw new BadRequestException(`Unknown or inactive credit package "${packageKey}".`);

    let amount = pkg.price;
    let creditsGranted = pkg.credits + pkg.bonusCredits;
    let couponId: string | undefined;
    let couponDiscountAmount = 0;
    let couponBonusCredits = 0;

    // Phase 3 — server-computed only; the discount/bonus is locked into the
    // PaymentRecord below and never re-trusted from anything the client
    // sends. See CouponsService.validate for the actual eligibility checks.
    if (couponCode) {
      const applied = await this.coupons.validate(couponCode, {
        organizationId,
        context: 'credit_purchase',
        amount,
        currencyCode: pkg.currency,
      });
      couponId = applied.coupon._id.toString();
      couponDiscountAmount = applied.discountAmount;
      couponBonusCredits = applied.bonusCredits;
      amount = amount - couponDiscountAmount;
      creditsGranted = creditsGranted + couponBonusCredits;
    }

    const order = await this.paymentProvider.createCheckoutOrder(organizationId, amount, pkg.currency, pkg.key);

    const record = await this.paymentRecordModel.create({
      organizationId,
      walletId: (await this.wallet.getOrCreateWallet(organizationId))._id.toString(),
      type: 'purchase',
      provider: this.paymentProvider.providerKey,
      creditPackageId: pkg.key,
      couponId,
      couponDiscountAmount: couponId ? couponDiscountAmount : undefined,
      couponBonusCredits: couponId ? couponBonusCredits : undefined,
      gatewayOrderId: order.orderId,
      amount,
      currency: pkg.currency,
      creditsGranted,
      status: order.simulated ? 'captured' : 'created',
      simulated: order.simulated,
    });

    if (!order.simulated) {
      return {
        paymentRecordId: record._id.toString(),
        orderId: order.orderId,
        checkoutParams: order.checkoutParams,
        simulated: false,
        creditedImmediately: false,
      };
    }

    await this.wallet.applyLedgerEntry(organizationId, 'PURCHASE', creditsGranted, {
      paymentRecordId: record._id.toString(),
      metadata: { packageKey: pkg.key, provider: this.paymentProvider.providerKey, simulated: true, gatewayOrderId: order.orderId },
      createdBy: userId,
    });
    await this.coupons.recordRedemption(record, userId, 'credit_purchase');
    await this.invoices.generateForPaymentRecord(record);

    return {
      paymentRecordId: record._id.toString(),
      orderId: order.orderId,
      checkoutParams: order.checkoutParams,
      simulated: true,
      creditedImmediately: true,
      wallet: await this.getWalletSummary(organizationId),
    };
  }

  /** Confirms a real (non-simulated) purchase right after checkout — the
   * path used when the app isn't publicly reachable, so a gateway webhook
   * (billing-webhook.controller.ts) can never arrive to grant credits on
   * its own. Not a weaker substitute for the webhook: each adapter's
   * confirmPayment() only returns success from cryptographic/API proof it
   * controls (a signature only the gateway could have produced, or a
   * direct re-fetch of the payment's status from the gateway's own API) —
   * never from anything the client merely claims.
   *
   * Safe to race an eventual webhook for the same payment: the status flip
   * from non-captured to 'captured' is itself the atomic guard
   * (findOneAndUpdate with a `status: {$ne: 'captured'}` filter) — whichever
   * of this method or the webhook handler gets there first grants the
   * credits; the second sees the record already captured and no-ops. */
  async confirmPurchase(
    organizationId: string,
    userId: string,
    paymentRecordId: string,
    gatewayPaymentId: string,
    signature: string,
  ): Promise<{ confirmed: boolean; wallet: WalletSummary }> {
    const record = await this.paymentRecordModel.findOne({ _id: paymentRecordId, organizationId });
    if (!record) throw new NotFoundException('Payment record not found.');

    if (record.status === 'captured') {
      // Already confirmed — by a previous call to this method, or by a
      // webhook that beat us to it. Idempotent, not an error.
      return { confirmed: true, wallet: await this.getWalletSummary(organizationId) };
    }

    const result = await this.paymentProvider.confirmPayment(record.gatewayOrderId, gatewayPaymentId, signature);
    if (!result.success) {
      throw new BadRequestException(result.reason ?? 'Payment could not be verified.');
    }

    const updated = await this.paymentRecordModel.findOneAndUpdate(
      { _id: paymentRecordId, status: { $ne: 'captured' } },
      { status: 'captured', gatewayPaymentId, gatewaySignature: signature },
      { new: true },
    );
    if (!updated) {
      // Lost the race to a concurrent webhook delivery — it already
      // credited the wallet, so this call must not credit it again.
      return { confirmed: true, wallet: await this.getWalletSummary(organizationId) };
    }

    await this.wallet.applyLedgerEntry(organizationId, updated.type === 'autopay' ? 'AUTO_RECHARGE' : 'PURCHASE', updated.creditsGranted, {
      paymentRecordId: updated._id.toString(),
      metadata: { packageKey: updated.creditPackageId, provider: this.paymentProvider.providerKey, gatewayPaymentId, simulated: false },
      createdBy: userId,
    });
    await this.coupons.recordRedemption(updated, userId, 'credit_purchase');
    await this.invoices.generateForPaymentRecord(updated);

    return { confirmed: true, wallet: await this.getWalletSummary(organizationId) };
  }

  /** `makeDefault` forces this method to become the org's default even when
   * it isn't the first one saved — used by the subscription-checkout flow,
   * where the card that paid for the plan should always become the Auto
   * Recharge default (see SubscriptionCheckoutModal.tsx). Credit-package
   * purchases don't pass it, preserving the original "first card saved
   * wins" behavior exactly. */
  async savePaymentMethod(
    organizationId: string,
    gatewayCustomerId: string,
    gatewayPaymentId: string,
    signature: string,
    gatewayOrderId: string,
    makeDefault = false,
  ) {
    let saved;
    try {
      saved = await this.paymentProvider.saveMethodFromCheckout(
        organizationId,
        gatewayCustomerId,
        gatewayPaymentId,
        signature,
        gatewayOrderId,
      );
    } catch (err) {
      // The active gateway only ever throws here on a failed/forged
      // checkout proof (e.g. no real order/payment/signature behind the
      // call) — a client-side mistake, not a server fault. Surfacing it as
      // a plain 400 (instead of letting the raw Error bubble into Nest's
      // generic 500 handler) is what turns "add payment method" into an
      // actionable message instead of a crash.
      const message = err instanceof Error ? err.message : 'Could not verify the payment for this card.';
      throw new BadRequestException(
        `${message} A payment method can only be saved from a real, completed checkout — purchase Haive Credits and choose to save your card at checkout to make it available for Auto Recharge.`,
      );
    }

    // Dedupe: the same physical card re-saved at a later checkout (e.g. an
    // org subscribing to a second plan, or re-using a card the gateway
    // issued a fresh per-transaction token for) shouldn't pile up as a
    // second row — reuse the existing one instead of inserting a duplicate.
    const existing = await this.paymentMethodModel.findOne({
      organizationId,
      provider: this.paymentProvider.providerKey,
      gatewayCustomerId: saved.gatewayCustomerId,
      cardLast4: saved.cardLast4,
      cardNetwork: saved.cardNetwork,
    });

    const isFirst = (await this.paymentMethodModel.countDocuments({ organizationId })) === 0;
    const shouldBeDefault = makeDefault || isFirst;

    if (shouldBeDefault) {
      await this.paymentMethodModel.updateMany({ organizationId, isDefault: true }, { isDefault: false });
    }

    if (existing) {
      existing.gatewayTokenIdEncrypted = saved.gatewayTokenIdEncrypted;
      if (shouldBeDefault) existing.isDefault = true;
      await existing.save();
      return existing;
    }

    return this.paymentMethodModel.create({
      organizationId,
      provider: this.paymentProvider.providerKey,
      gatewayCustomerId: saved.gatewayCustomerId,
      gatewayTokenIdEncrypted: saved.gatewayTokenIdEncrypted,
      cardLast4: saved.cardLast4,
      cardNetwork: saved.cardNetwork,
      isDefault: shouldBeDefault,
    });
  }

  /** Lets the customer switch which saved card Auto Recharge (and any
   * future manual purchase's pre-selected method) uses, without re-entering
   * card details — see BillingController's Change-Payment-Method flow. */
  async setDefaultPaymentMethod(organizationId: string, paymentMethodId: string) {
    const method = await this.paymentMethodModel.findOne({ _id: paymentMethodId, organizationId });
    if (!method) throw new NotFoundException('Payment method not found.');

    await this.paymentMethodModel.updateMany({ organizationId, isDefault: true }, { isDefault: false });
    method.isDefault = true;
    await method.save();
    return method;
  }

  async deletePaymentMethod(organizationId: string, paymentMethodId: string) {
    const result = await this.paymentMethodModel.deleteOne({ _id: paymentMethodId, organizationId });
    if (result.deletedCount === 0) throw new NotFoundException('Payment method not found.');
  }
}
