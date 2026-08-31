import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PAYMENT_PROVIDER, PaymentProviderAdapter } from './providers/payment-provider.interface';
import { WalletService } from './wallet.service';
import { addBillingCycle, RecurringBillingCycle } from './billing-cycle.util';
import { BillingInvoiceService } from './billing-invoice.service';
import { CouponsService } from './coupons.service';
import { ConfirmSubscriptionDto } from './dto/confirm-subscription.dto';
import { SubscriptionCheckoutDto } from './dto/subscription-checkout.dto';
import { BillingFeature, BillingFeatureDocument } from './schemas/billing-feature.schema';
import { BillingPlan, BillingPlanDocument } from './schemas/billing-plan.schema';
import { BillingCycle, BillingPlanPrice, BillingPlanPriceDocument } from './schemas/billing-plan-price.schema';
import { BillingSubscriptionEvent, BillingSubscriptionEventDocument } from './schemas/billing-subscription-event.schema';
import { BillingSubscription, BillingSubscriptionDocument, BillingSubscriptionStatus } from './schemas/billing-subscription.schema';
import { PaymentRecord, PaymentRecordDocument } from './schemas/payment-record.schema';

export interface PublicPlanPrice {
  id: string;
  currencyCode: string;
  billingCycle: BillingCycle;
  amount: number;
  creditsGranted: number;
}

// Same {featureKey, enabled, valueOverride} shape stored on BillingPlan,
// plus `name` resolved from the BillingFeature catalog purely for display —
// the underlying grant/storage shape on the plan document is untouched.
export type PublicPlanFeature = BillingPlan['features'][number] & { name?: string };

export interface PublicPlanListing {
  id: string;
  key: string;
  name: string;
  description?: string;
  shortDescription?: string;
  icon?: string;
  image?: string;
  badgeText?: string;
  badgeColor?: string;
  planColor?: string;
  recommended: boolean;
  trialDays?: number;
  features: PublicPlanFeature[];
  limits: BillingPlan['limits'];
  prices: PublicPlanPrice[];
}

export interface SubscriptionSummary {
  id: string;
  status: BillingSubscriptionStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  plan: { id: string; key: string; name: string } | null;
  price: { id: string; currencyCode: string; billingCycle: BillingCycle; amount: number; creditsGranted: number } | null;
}

export interface InitiateSubscriptionCheckoutResult {
  paymentRecordId: string;
  orderId: string;
  checkoutParams: Record<string, unknown>;
  simulated: boolean;
  activatedImmediately: boolean;
  subscription?: SubscriptionSummary;
}

/**
 * Customer-facing subscription operations — the Phase 2 layer that sits on
 * top of the existing credits wallet: subscribing to a plan grants a
 * recurring credit allotment (WalletService.applyLedgerEntry('SUBSCRIPTION_GRANT', ...))
 * rather than creating an independent money system. Reuses the exact
 * checkout/confirm/webhook-race patterns BillingService already established
 * for credit-package purchases — see initiatePurchase/confirmPurchase there
 * for the precedent this mirrors.
 */
@Injectable()
export class BillingSubscriptionsService {
  constructor(
    @InjectModel(BillingPlan.name) private planModel: Model<BillingPlanDocument>,
    @InjectModel(BillingPlanPrice.name) private priceModel: Model<BillingPlanPriceDocument>,
    @InjectModel(BillingFeature.name) private featureModel: Model<BillingFeatureDocument>,
    @InjectModel(BillingSubscription.name) private subscriptionModel: Model<BillingSubscriptionDocument>,
    @InjectModel(BillingSubscriptionEvent.name) private eventModel: Model<BillingSubscriptionEventDocument>,
    @InjectModel(PaymentRecord.name) private paymentRecordModel: Model<PaymentRecordDocument>,
    @Inject(PAYMENT_PROVIDER) private paymentProvider: PaymentProviderAdapter,
    private wallet: WalletService,
    private coupons: CouponsService,
    private invoices: BillingInvoiceService,
  ) {}

  /** Public catalog — active + isPublic plans only, with their currently
   * active price(s). Never returns BillingPlan.internalDescription — same
   * admin-only-context-never-leaves-the-server discipline as
   * BillingService.listCustomerTransactions stripping WalletTransaction.metadata.
   *
   * Currency: when a specific currencyCode IS requested, only that
   * currency's prices are returned (unchanged behavior). When none is
   * requested — the public /pricing page's own call — every active
   * currency a plan happens to be priced in is returned, not just one
   * hardcoded/env-default currency; previously a plan priced only in a
   * non-default currency (e.g. USD when the env default was INR) silently
   * had zero prices and was filtered off the page entirely. Each price
   * still carries its own currencyCode, so the frontend renders whatever
   * currency it actually is — this doesn't do cross-currency conversion or
   * change what a plan's checkout ever charges.
   */
  async listPublicPlans(currencyCode?: string): Promise<PublicPlanListing[]> {
    const plans = await this.planModel.find({ active: true, isPublic: true }).sort({ sortOrder: 1 }).exec();
    if (plans.length === 0) return [];

    const planIds = plans.map((p) => p._id.toString());
    const priceQuery: Record<string, unknown> = { planId: { $in: planIds }, active: true, effectiveTo: null };
    if (currencyCode) {
      priceQuery.currencyCode = currencyCode.toUpperCase();
    }
    const prices = await this.priceModel.find(priceQuery).sort({ billingCycle: 1 }).exec();

    const pricesByPlan = new Map<string, BillingPlanPriceDocument[]>();
    for (const price of prices) {
      const list = pricesByPlan.get(price.planId) ?? [];
      list.push(price);
      pricesByPlan.set(price.planId, list);
    }

    // Resolves each grant's featureKey to the catalog's display name —
    // plans only ever store the key (see BillingPlanFeatureGrantDto), so
    // without this the public page had nothing but the raw internal slug
    // to show for any feature that didn't have an explicit valueOverride.
    const allFeatureKeys = new Set<string>();
    for (const plan of plans) {
      for (const grant of plan.features) allFeatureKeys.add(grant.featureKey);
    }
    const featureDocs = allFeatureKeys.size > 0 ? await this.featureModel.find({ key: { $in: [...allFeatureKeys] } }).exec() : [];
    const featureNameByKey = new Map(featureDocs.map((f) => [f.key, f.name]));

    return plans.map((plan) => ({
      id: plan._id.toString(),
      key: plan.key,
      name: plan.name,
      description: plan.description,
      shortDescription: plan.shortDescription,
      icon: plan.icon,
      image: plan.image,
      badgeText: plan.badgeText,
      badgeColor: plan.badgeColor,
      planColor: plan.planColor,
      recommended: plan.recommended,
      trialDays: plan.trialDays,
      features: plan.features.map((grant) => ({ ...grant, name: featureNameByKey.get(grant.featureKey) })),
      limits: plan.limits,
      prices: (pricesByPlan.get(plan._id.toString()) ?? []).map((price) => ({
        id: price._id.toString(),
        currencyCode: price.currencyCode,
        billingCycle: price.billingCycle,
        amount: price.amount,
        creditsGranted: price.creditsGranted,
      })),
    }));
  }

  async getCurrentSubscription(organizationId: string): Promise<SubscriptionSummary | null> {
    const subscription = await this.subscriptionModel
      .findOne({ organizationId, status: { $in: ['trialing', 'active', 'past_due'] } })
      .exec();
    if (!subscription) return null;
    return this.toSummary(subscription);
  }

  /** Creates a checkout order for a recurring plan price. Like
   * BillingService.initiatePurchase, a real (non-simulated) checkout is not
   * activated here — only once confirm()/the webhook observes a verified
   * payment.captured does activateFromCheckoutPayment ever run. In
   * simulated mode (no active-gateway keys) that confirmation can never
   * arrive from a real webhook, so it's applied synchronously in this same
   * request instead, exactly like initiatePurchase's simulated branch. */
  async checkout(organizationId: string, userId: string, dto: SubscriptionCheckoutDto): Promise<InitiateSubscriptionCheckoutResult> {
    const plan = await this.planModel.findOne({ _id: dto.planId, active: true }).exec();
    if (!plan) throw new BadRequestException('Unknown or inactive plan.');

    const price = await this.priceModel.findOne({ _id: dto.priceId, planId: dto.planId, active: true, effectiveTo: null }).exec();
    if (!price) throw new BadRequestException('Unknown or inactive price for this plan.');

    if (price.billingCycle === 'one_time') {
      throw new BadRequestException('This price is a one-time price, not a recurring subscription — use a credit package purchase instead.');
    }

    // A DIFFERENT plan while one is already active is allowed through — an
    // upgrade/switch — and handled in activateFromCheckoutPayment below,
    // which immediately supersedes the old subscription right before
    // inserting the new one (the unique partial index only allows one
    // active subscription per org at a time). Re-checking out the exact
    // same currently-active plan is still rejected; there's nothing to do.
    const existing = await this.subscriptionModel
      .findOne({ organizationId, status: { $in: ['trialing', 'active', 'past_due'] } })
      .exec();
    if (existing && existing.planId === dto.planId) {
      throw new BadRequestException('Already subscribed to this plan.');
    }

    let amount = price.amount;
    let creditsGranted = price.creditsGranted;
    let couponId: string | undefined;
    let couponDiscountAmount = 0;
    let couponBonusCredits = 0;

    if (dto.couponCode) {
      const applied = await this.coupons.validate(dto.couponCode, {
        organizationId,
        context: 'subscription_checkout',
        planId: dto.planId,
        amount,
        currencyCode: price.currencyCode,
      });
      couponId = applied.coupon._id.toString();
      couponDiscountAmount = applied.discountAmount;
      couponBonusCredits = applied.bonusCredits;
      amount = amount - couponDiscountAmount;
      creditsGranted = creditsGranted + couponBonusCredits;
    }

    const order = await this.paymentProvider.createCheckoutOrder(
      organizationId,
      amount,
      price.currencyCode,
      `plan_${plan.key}_${price.billingCycle}`,
    );

    const wallet = await this.wallet.getOrCreateWallet(organizationId);
    const record = await this.paymentRecordModel.create({
      organizationId,
      walletId: wallet._id.toString(),
      type: 'subscription_checkout',
      provider: this.paymentProvider.providerKey,
      subscriptionPlanId: dto.planId,
      subscriptionPriceId: dto.priceId,
      couponId,
      couponDiscountAmount: couponId ? couponDiscountAmount : undefined,
      couponBonusCredits: couponId ? couponBonusCredits : undefined,
      gatewayOrderId: order.orderId,
      amount,
      currency: price.currencyCode,
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
        activatedImmediately: false,
      };
    }

    const subscription = await this.activateFromCheckoutPayment(record, userId);
    return {
      paymentRecordId: record._id.toString(),
      orderId: order.orderId,
      checkoutParams: order.checkoutParams,
      simulated: true,
      activatedImmediately: true,
      subscription: await this.toSummary(subscription),
    };
  }

  /** Mirrors BillingService.confirmPurchase's exact race-safety shape — see
   * that method's comment for why this is safe to race an eventual webhook
   * delivery for the same payment without ever activating twice. */
  async confirm(
    organizationId: string,
    userId: string,
    dto: ConfirmSubscriptionDto,
  ): Promise<{ confirmed: boolean; subscription: SubscriptionSummary | null }> {
    const record = await this.paymentRecordModel
      .findOne({ _id: dto.paymentRecordId, organizationId, type: 'subscription_checkout' })
      .exec();
    if (!record) throw new NotFoundException('Subscription checkout not found.');

    if (record.status === 'captured') {
      const subscription = record.subscriptionId ? await this.subscriptionModel.findById(record.subscriptionId).exec() : null;
      return { confirmed: true, subscription: subscription ? await this.toSummary(subscription) : null };
    }

    const result = await this.paymentProvider.confirmPayment(record.gatewayOrderId, dto.gatewayPaymentId, dto.signature ?? '');
    if (!result.success) {
      throw new BadRequestException(result.reason ?? 'Payment could not be verified.');
    }

    const updated = await this.paymentRecordModel.findOneAndUpdate(
      { _id: dto.paymentRecordId, status: { $ne: 'captured' } },
      { status: 'captured', gatewayPaymentId: dto.gatewayPaymentId, gatewaySignature: dto.signature ?? '' },
      { new: true },
    );
    if (!updated) {
      // Lost the race to a concurrent webhook delivery — it already activated.
      const existing = await this.subscriptionModel
        .findOne({ organizationId, status: { $in: ['trialing', 'active', 'past_due'] } })
        .exec();
      return { confirmed: true, subscription: existing ? await this.toSummary(existing) : null };
    }

    const subscription = await this.activateFromCheckoutPayment(updated, userId);
    return { confirmed: true, subscription: await this.toSummary(subscription) };
  }

  /** The single place a subscription_checkout/subscription_renewal
   * PaymentRecord turns into real entitlement — called from confirm() above,
   * from billing-webhook.controller.ts's payment.captured handler, and from
   * subscription-renewal.service.ts. Idempotent: if the record already
   * carries a subscriptionId, returns the existing subscription rather than
   * creating a second one. */
  async activateFromCheckoutPayment(record: PaymentRecordDocument, actorUserId: string): Promise<BillingSubscriptionDocument> {
    if (record.subscriptionId) {
      const existing = await this.subscriptionModel.findById(record.subscriptionId).exec();
      if (existing) return existing;
    }

    const planId = record.subscriptionPlanId;
    const priceId = record.subscriptionPriceId;
    if (!planId || !priceId) {
      throw new Error(`PaymentRecord ${record._id.toString()} has no subscription plan/price intent recorded.`);
    }
    const price = await this.priceModel.findById(priceId).exec();
    if (!price) {
      throw new Error(`BillingPlanPrice ${priceId} referenced by PaymentRecord ${record._id.toString()} no longer exists.`);
    }

    const now = new Date();
    const periodEnd = addBillingCycle(now, price.billingCycle as RecurringBillingCycle);

    // Upgrade/switch case — checkout() already allowed this through when it
    // was for a different plan than whatever's currently active. Terminate
    // the old subscription right now (immediate, not the usual soft
    // cancelAtPeriodEnd) so the unique partial index — one active
    // subscription per org — is satisfied before the new one inserts below.
    // No credit clawback: this is a prepaid wallet, the balance simply
    // carries over; only the recurring grant going forward changes.
    const superseded = await this.subscriptionModel
      .findOne({ organizationId: record.organizationId, status: { $in: ['trialing', 'active', 'past_due'] } })
      .exec();
    if (superseded) {
      superseded.status = 'canceled';
      superseded.cancelAtPeriodEnd = true;
      await superseded.save();
      await this.eventModel.create({
        subscriptionId: superseded._id.toString(),
        organizationId: record.organizationId,
        type: 'canceled',
        metadata: { reason: 'superseded_by_upgrade', newPlanId: planId },
      });
    }

    let subscription: BillingSubscriptionDocument;
    try {
      subscription = await this.subscriptionModel.create({
        organizationId: record.organizationId,
        planId,
        planPriceId: priceId,
        status: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
        lastRenewalPaymentRecordId: record._id.toString(),
        renewalFailureCount: 0,
        createdBy: actorUserId,
        couponId: record.couponId,
      });
    } catch (err) {
      const mongoErr = err as { code?: number };
      if (mongoErr.code === 11000) {
        // Lost a race to another concurrent activation for the same org —
        // the unique partial index (see billing-subscription.schema.ts) is
        // the final guard. Return the org's now-live subscription instead
        // of erroring; this payment simply didn't win the race.
        const existing = await this.subscriptionModel
          .findOne({ organizationId: record.organizationId, status: { $in: ['trialing', 'active', 'past_due'] } })
          .exec();
        if (existing) return existing;
      }
      throw err;
    }

    // record.creditsGranted (not price.creditsGranted) — already includes
    // any coupon free_credits bonus locked in at checkout time (see
    // checkout() above), so this is the correct total to grant regardless
    // of whether a coupon was applied.
    await this.wallet.applyLedgerEntry(record.organizationId, 'SUBSCRIPTION_GRANT', record.creditsGranted, {
      paymentRecordId: record._id.toString(),
      metadata: { planId, priceId, billingCycle: price.billingCycle, subscriptionId: subscription._id.toString() },
      createdBy: actorUserId,
    });

    record.subscriptionId = subscription._id.toString();
    await record.save();
    await this.coupons.recordRedemption(record, actorUserId, 'subscription_checkout');
    await this.invoices.generateForPaymentRecord(record);

    await this.eventModel.create({
      subscriptionId: subscription._id.toString(),
      organizationId: record.organizationId,
      type: 'created',
      metadata: { planId, priceId, paymentRecordId: record._id.toString() },
    });

    return subscription;
  }

  /** Soft cancel — the subscription keeps its entitlement through
   * currentPeriodEnd; subscription-renewal.service.ts is what actually
   * flips status to 'canceled' once that date passes, rather than clawing
   * back already-granted credits or access immediately. */
  async cancel(organizationId: string): Promise<SubscriptionSummary> {
    const subscription = await this.subscriptionModel
      .findOne({ organizationId, status: { $in: ['trialing', 'active', 'past_due'] } })
      .exec();
    if (!subscription) throw new NotFoundException('No active subscription found for this organization.');

    subscription.cancelAtPeriodEnd = true;
    await subscription.save();

    await this.eventModel.create({
      subscriptionId: subscription._id.toString(),
      organizationId,
      type: 'canceled',
      metadata: { effectiveAt: subscription.currentPeriodEnd },
    });

    return this.toSummary(subscription);
  }

  /** Admin-only cross-org list (Admin-haive's Subscriptions page) — the
   * customer-facing getCurrentSubscription above is intentionally
   * self-scoped and stays that way; this is a separate method, not a widened
   * version of it, gated by billing-admin-subscriptions.controller.ts's
   * @Roles('platform_admin'). */
  async adminList(filters: { organizationId?: string; status?: string; page?: number; limit?: number }) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 25;
    const query: Record<string, unknown> = {};
    if (filters.organizationId) query.organizationId = filters.organizationId;
    if (filters.status) query.status = filters.status;
    const [rows, total] = await Promise.all([
      this.subscriptionModel.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).exec(),
      this.subscriptionModel.countDocuments(query).exec(),
    ]);
    const items = await Promise.all(
      rows.map(async (row) => ({ ...(await this.toSummary(row)), organizationId: row.organizationId })),
    );
    return { items, total, page, limit };
  }

  /** Reuses the exact same soft-cancel primitive cancel() above uses
   * (cancelAtPeriodEnd=true, entitlement continues through the current
   * period, subscription-renewal.service.ts flips status at the actual
   * period end) — just callable for any org, not only the caller's own. */
  async adminCancel(subscriptionId: string): Promise<SubscriptionSummary> {
    const subscription = await this.subscriptionModel
      .findOne({ _id: subscriptionId, status: { $in: ['trialing', 'active', 'past_due'] } })
      .exec();
    if (!subscription) throw new NotFoundException('No cancelable subscription found with that id.');

    subscription.cancelAtPeriodEnd = true;
    await subscription.save();
    await this.eventModel.create({
      subscriptionId: subscription._id.toString(),
      organizationId: subscription.organizationId,
      type: 'canceled',
      metadata: { effectiveAt: subscription.currentPeriodEnd, actor: 'platform_admin' },
    });
    return this.toSummary(subscription);
  }

  /** Clears a pending cancellation while the subscription is still within
   * its current period — no-op change to billing state itself (no renewal
   * has happened, no credits move); subscription-renewal.service.ts simply
   * stops treating this subscription as due for cancellation at period end. */
  async adminReactivate(subscriptionId: string): Promise<SubscriptionSummary> {
    const subscription = await this.subscriptionModel
      .findOne({ _id: subscriptionId, status: { $in: ['trialing', 'active', 'past_due'] }, cancelAtPeriodEnd: true })
      .exec();
    if (!subscription) throw new NotFoundException('No pending-cancellation subscription found with that id.');

    subscription.cancelAtPeriodEnd = false;
    await subscription.save();
    await this.eventModel.create({
      subscriptionId: subscription._id.toString(),
      organizationId: subscription.organizationId,
      type: 'plan_changed',
      metadata: { reactivated: true, actor: 'platform_admin' },
    });
    return this.toSummary(subscription);
  }

  private async toSummary(subscription: BillingSubscriptionDocument): Promise<SubscriptionSummary> {
    const [plan, price] = await Promise.all([
      this.planModel.findById(subscription.planId).exec(),
      this.priceModel.findById(subscription.planPriceId).exec(),
    ]);
    return {
      id: subscription._id.toString(),
      status: subscription.status,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      plan: plan ? { id: plan._id.toString(), key: plan.key, name: plan.name } : null,
      price: price
        ? { id: price._id.toString(), currencyCode: price.currencyCode, billingCycle: price.billingCycle, amount: price.amount, creditsGranted: price.creditsGranted }
        : null,
    };
  }
}
