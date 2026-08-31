import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AgentExecution, AgentExecutionDocument } from '../command-center/schemas/agent-execution.schema';
import { CommandCenterService } from '../command-center/command-center.service';
import { Organization, OrganizationDocument } from '../organizations/schemas/organization.schema';
import { User, UserDocument } from '../users/schemas/user.schema';
import { PricingService } from './pricing.service';
import { WalletService } from './wallet.service';
import { BillingPlan, BillingPlanDocument } from './schemas/billing-plan.schema';
import { BillingPlanPrice, BillingPlanPriceDocument } from './schemas/billing-plan-price.schema';
import { BillingSubscriptionEvent, BillingSubscriptionEventDocument } from './schemas/billing-subscription-event.schema';
import { BillingSubscription, BillingSubscriptionDocument } from './schemas/billing-subscription.schema';
import { Currency, CurrencyDocument } from './schemas/currency.schema';
import { PaymentRecord, PaymentRecordDocument } from './schemas/payment-record.schema';
import { Wallet, WalletDocument } from './schemas/wallet.schema';
import { WalletTransaction, WalletTransactionDocument } from './schemas/wallet-transaction.schema';

export interface OrganizationDirectoryEntry {
  organizationId: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
  userCount: number;
  planName: string | null;
  subscriptionStatus: string | null;
  walletBalanceCredits: number;
  creditsUsed: number;
  revenueUsd: number;
  providerCostUsd: number;
  grossProfitUsd: number;
  totalRequests: number;
  createdAt: Date;
}

export interface OrganizationDirectoryPage {
  items: OrganizationDirectoryEntry[];
  total: number;
  page: number;
  limit: number;
}

export interface AdminDashboard {
  days: number;
  totalOrganizations: number;
  activeOrganizations: number;
  totalUsers: number;
  activeSubscriptions: number;
  revenueUsd: number;
  successfulPaymentsCount: number;
  failedPaymentsCount: number;
  refundedPaymentsCount: number;
  creditsSold: number;
  creditsUsed: number;
  creditsOutstanding: number;
  autoRechargeEnabledWallets: number;
  autoRechargeEventsInPeriod: number;
}

export interface AnalyticsSeriesPoint {
  date: string;
  value: number;
}

export interface AdminAnalytics {
  days: number;
  revenueSeries: AnalyticsSeriesPoint[];
  creditUsageSeries: AnalyticsSeriesPoint[];
  newOrganizationsSeries: AnalyticsSeriesPoint[];
  subscriptionGrowthSeries: AnalyticsSeriesPoint[];
  paymentSuccessSeries: AnalyticsSeriesPoint[];
  paymentFailureSeries: AnalyticsSeriesPoint[];
  planDistribution: { planName: string; count: number }[];
}

export interface AdminOverview {
  days: number;
  revenueUsd: number;
  providerCostUsd: number;
  grossProfitUsd: number;
  realizedMarginPct: number;
  creditsSold: number;
  creditsUsed: number;
  totalAiRequests: number;
  // Phase 7 additions — reuse the same credits->USD accounting the rest of
  // this method already uses (via the WalletTransaction ledger), rather
  // than converting Refund.amount's raw per-gateway currency values
  // separately; a successful refund always writes a REFUND ledger row (see
  // RefundService), so this stays consistent with revenueUsd's own source.
  refundedUsd: number;
  refundsCount: number;
  failedPaymentsCount: number;
  totalCustomers: number;
}

export interface SubscriptionMetrics {
  days: number;
  mrrUsd: number;
  arrUsd: number;
  activeCount: number;
  trialingCount: number;
  pastDueCount: number;
  canceledCount: number;
  expiredCount: number;
  newSubscriptionsInPeriod: number;
  canceledInPeriod: number;
  // Approximate: (canceled/expired events in the period) / (current active
  // count + those same churn events), as a stand-in for "active count at
  // the START of the period" — this schema keeps no point-in-time
  // subscription-count snapshots, so this is the closest available proxy,
  // not a textbook cohort-based churn calculation. Good enough for a
  // dashboard trend indicator; documented here so it's never mistaken for
  // more precise than it is.
  churnRatePct: number;
}

/**
 * Haive-internal-only aggregation — everything here is gated by
 * @Roles('platform_admin') in billing-admin.controller.ts and must never be
 * reachable through a customer-facing route. Joins WalletTransaction +
 * PaymentRecord against agent_executions at query time; nothing here is
 * denormalized back onto agent_executions itself.
 */
@Injectable()
export class BillingAdminService {
  constructor(
    @InjectModel(WalletTransaction.name) private transactionModel: Model<WalletTransactionDocument>,
    @InjectModel(PaymentRecord.name) private paymentRecordModel: Model<PaymentRecordDocument>,
    @InjectModel(AgentExecution.name) private executionModel: Model<AgentExecutionDocument>,
    @InjectModel(Organization.name) private orgModel: Model<OrganizationDocument>,
    @InjectModel(BillingSubscription.name) private subscriptionModel: Model<BillingSubscriptionDocument>,
    @InjectModel(BillingSubscriptionEvent.name) private eventModel: Model<BillingSubscriptionEventDocument>,
    @InjectModel(BillingPlanPrice.name) private priceModel: Model<BillingPlanPriceDocument>,
    @InjectModel(BillingPlan.name) private planModel: Model<BillingPlanDocument>,
    @InjectModel(Currency.name) private currencyModel: Model<CurrencyDocument>,
    @InjectModel(Wallet.name) private walletModel: Model<WalletDocument>,
    @InjectModel(User.name) private userModel: Model<UserDocument>,
    private commandCenter: CommandCenterService,
    private pricing: PricingService,
    private wallet: WalletService,
    private config: ConfigService,
  ) {}

  async getOverview(days = 30): Promise<AdminOverview> {
    const since = new Date(Date.now() - days * 86_400_000);

    const [revenueRows, costRows, refundRows, failedPaymentsCount, totalCustomers] = await Promise.all([
      this.transactionModel
        .aggregate<{ credits: number }>([
          { $match: { type: { $in: ['PURCHASE', 'AUTO_RECHARGE'] }, createdAt: { $gte: since } } },
          { $group: { _id: null, credits: { $sum: '$amountCredits' } } },
        ])
        .exec(),
      this.executionModel
        .aggregate<{ costUsd: number; count: number }>([
          { $match: { kind: 'llm', occurredAt: { $gte: since } } },
          { $group: { _id: null, costUsd: { $sum: { $ifNull: ['$costUsd', 0] } }, count: { $sum: 1 } } },
        ])
        .exec(),
      this.transactionModel
        .aggregate<{ credits: number; count: number }>([
          { $match: { type: 'REFUND', createdAt: { $gte: since } } },
          { $group: { _id: null, credits: { $sum: { $abs: '$amountCredits' } }, count: { $sum: 1 } } },
        ])
        .exec(),
      this.paymentRecordModel.countDocuments({ status: 'failed', createdAt: { $gte: since } }).exec(),
      this.orgModel.countDocuments().exec(),
    ]);

    const usageRows = await this.transactionModel
      .aggregate<{ credits: number }>([
        { $match: { type: 'AI_USAGE', createdAt: { $gte: since } } },
        { $group: { _id: null, credits: { $sum: { $abs: '$amountCredits' } } } },
      ])
      .exec();

    const creditsSold = revenueRows[0]?.credits ?? 0;
    const creditsUsed = usageRows[0]?.credits ?? 0;
    const revenueUsd = this.pricing.creditsToUsd(creditsSold);
    const providerCostUsd = costRows[0]?.costUsd ?? 0;
    const grossProfitUsd = revenueUsd - providerCostUsd;
    const realizedMarginPct = revenueUsd > 0 ? Math.round((grossProfitUsd / revenueUsd) * 1000) / 10 : 0;

    return {
      days,
      revenueUsd,
      providerCostUsd,
      grossProfitUsd,
      realizedMarginPct,
      creditsSold,
      creditsUsed,
      totalAiRequests: costRows[0]?.count ?? 0,
      refundedUsd: this.pricing.creditsToUsd(refundRows[0]?.credits ?? 0),
      refundsCount: refundRows[0]?.count ?? 0,
      failedPaymentsCount,
      totalCustomers,
    };
  }

  /** MRR/ARR/churn — Phase 7. MRR normalizes every currently-ACTIVE
   * subscription's locked-in BillingPlanPrice to a monthly-equivalent USD
   * figure (yearly/12, quarterly/3, weekly*52/12), converting each price's
   * own currency to USD via the matching Currency catalog row (falling back
   * to the platform default rate for a currency with no catalog row) —
   * unlike getOverview's credits-based revenue, a subscription price is
   * never routed through the credits ledger before this point, so it needs
   * its own currency conversion here. */
  async getSubscriptionMetrics(days = 30): Promise<SubscriptionMetrics> {
    const since = new Date(Date.now() - days * 86_400_000);

    const [statusCounts, activeSubscriptions, newSubscriptionsInPeriod, canceledInPeriod] = await Promise.all([
      this.subscriptionModel.aggregate<{ _id: string; count: number }>([{ $group: { _id: '$status', count: { $sum: 1 } } }]).exec(),
      this.subscriptionModel.find({ status: 'active' }).exec(),
      this.eventModel.countDocuments({ type: 'created', createdAt: { $gte: since } }).exec(),
      this.eventModel.countDocuments({ type: { $in: ['canceled', 'expired'] }, createdAt: { $gte: since } }).exec(),
    ]);
    const countByStatus = (status: string) => statusCounts.find((s) => s._id === status)?.count ?? 0;

    const priceIds = [...new Set(activeSubscriptions.map((s) => s.planPriceId))];
    const prices = priceIds.length > 0 ? await this.priceModel.find({ _id: { $in: priceIds } }).exec() : [];
    const priceById = new Map(prices.map((p) => [p._id.toString(), p]));

    const currencyCodes = [...new Set(prices.map((p) => p.currencyCode))];
    const currencies = currencyCodes.length > 0 ? await this.currencyModel.find({ code: { $in: currencyCodes } }).exec() : [];
    const rateByCode = new Map(currencies.map((c) => [c.code, c.usdToCurrencyRate]));
    const defaultRate = this.config.get<number>('billing.usdToCurrencyRate') ?? 83;

    let mrrUsd = 0;
    for (const sub of activeSubscriptions) {
      const price = priceById.get(sub.planPriceId);
      if (!price) continue;
      const rate = rateByCode.get(price.currencyCode) ?? defaultRate;
      const amountUsd = price.amount / rate;
      const monthlyUsd =
        price.billingCycle === 'yearly'
          ? amountUsd / 12
          : price.billingCycle === 'quarterly'
            ? amountUsd / 3
            : price.billingCycle === 'weekly'
              ? amountUsd * (52 / 12)
              : amountUsd; // monthly (the only other cycle a subscription can carry)
      mrrUsd += monthlyUsd;
    }
    mrrUsd = Math.round(mrrUsd * 100) / 100;

    const activeAtStart = countByStatus('active') + canceledInPeriod;
    const churnRatePct = activeAtStart > 0 ? Math.round((canceledInPeriod / activeAtStart) * 1000) / 10 : 0;

    return {
      days,
      mrrUsd,
      arrUsd: Math.round(mrrUsd * 12 * 100) / 100,
      activeCount: countByStatus('active'),
      trialingCount: countByStatus('trialing'),
      pastDueCount: countByStatus('past_due'),
      canceledCount: countByStatus('canceled'),
      expiredCount: countByStatus('expired'),
      newSubscriptionsInPeriod,
      canceledInPeriod,
      churnRatePct,
    };
  }

  /** Minimal current-subscription lookup used by getOrganizationBreakdown/
   * getOrganizationDetail below — deliberately NOT a call into
   * BillingSubscriptionsService.getCurrentSubscription: that service also
   * depends on PAYMENT_PROVIDER/CouponsService/BillingInvoiceService (the
   * full checkout stack), which would drag a large, unrelated dependency
   * graph into this read-only aggregation service purely to read a status
   * string and a plan name. Every model this needs (subscriptionModel/
   * priceModel/planModel) is already injected above for other methods. */
  private async currentSubscriptionFor(organizationId: string) {
    const subscription = await this.subscriptionModel
      .findOne({ organizationId, status: { $in: ['trialing', 'active', 'past_due'] } })
      .exec();
    if (!subscription) return null;
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
      price: price ? { id: price._id.toString(), currencyCode: price.currencyCode, billingCycle: price.billingCycle, amount: price.amount } : null,
    };
  }

  /** Per-org breakdown — reuses CommandCenterService.getSummary() for the
   * provider-cost side rather than re-deriving that aggregation. `page`
   * left undefined preserves the exact original behavior/shape (every org,
   * plain array) that PlatformAdminBillingPage.tsx already depends on; the
   * new Admin-haive Organizations directory page is the only caller that
   * passes page/limit/search/sortBy, which additionally wraps the result in
   * a {items,total,page,limit} envelope. Every field this method already
   * returned is still present — the additive fields (status/userCount/
   * planName/subscriptionStatus/walletBalanceCredits/creditsUsed/createdAt)
   * are simply new keys an old caller never reads. */
  async getOrganizationBreakdown(
    days = 30,
    opts?: { page?: number; limit?: number; search?: string; sortBy?: 'name' | 'createdAt' | 'revenueUsd' | 'userCount' },
  ): Promise<OrganizationDirectoryEntry[] | OrganizationDirectoryPage> {
    const query: Record<string, unknown> = {};
    if (opts?.search) {
      const escaped = opts.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [{ name: { $regex: escaped, $options: 'i' } }, { slug: { $regex: escaped, $options: 'i' } }];
    }

    const total = await this.orgModel.countDocuments(query).exec();
    let orgQuery = this.orgModel.find(query);
    if (opts?.page) {
      const limit = opts.limit ?? 25;
      orgQuery = orgQuery.skip((opts.page - 1) * limit).limit(limit);
    }
    const orgs = await orgQuery.exec();

    const results = await Promise.all(
      orgs.map(async (org) => {
        const organizationId = org._id.toString();
        const since = new Date(Date.now() - days * 86_400_000);
        const [summary, revenueRows, usageRows, userCount, walletDoc, subscription] = await Promise.all([
          this.commandCenter.getSummary(organizationId, days),
          this.transactionModel
            .aggregate<{ credits: number }>([
              { $match: { organizationId, type: { $in: ['PURCHASE', 'AUTO_RECHARGE'] }, createdAt: { $gte: since } } },
              { $group: { _id: null, credits: { $sum: '$amountCredits' } } },
            ])
            .exec(),
          this.transactionModel
            .aggregate<{ credits: number }>([
              { $match: { organizationId, type: 'AI_USAGE', createdAt: { $gte: since } } },
              { $group: { _id: null, credits: { $sum: { $abs: '$amountCredits' } } } },
            ])
            .exec(),
          this.userModel.countDocuments({ organizationId }).exec(),
          this.walletModel.findOne({ organizationId }).exec(),
          this.currentSubscriptionFor(organizationId),
        ]);
        const revenueUsd = this.pricing.creditsToUsd(revenueRows[0]?.credits ?? 0);
        const providerCostUsd = summary.totalCost;
        return {
          organizationId,
          name: org.name,
          slug: org.slug,
          status: org.status,
          userCount,
          planName: subscription?.plan?.name ?? null,
          subscriptionStatus: subscription?.status ?? null,
          walletBalanceCredits: walletDoc ? walletDoc.balanceCredits - walletDoc.reservedCredits : 0,
          creditsUsed: usageRows[0]?.credits ?? 0,
          revenueUsd,
          providerCostUsd,
          grossProfitUsd: revenueUsd - providerCostUsd,
          totalRequests: summary.totalCalls,
          createdAt: (org as unknown as { createdAt: Date }).createdAt,
        };
      }),
    );

    if (opts?.sortBy) {
      const key = opts.sortBy;
      results.sort((a, b) => {
        if (key === 'name') return a.name.localeCompare(b.name);
        if (key === 'createdAt') return b.createdAt.getTime() - a.createdAt.getTime();
        if (key === 'userCount') return b.userCount - a.userCount;
        return b.revenueUsd - a.revenueUsd;
      });
    }

    if (!opts?.page) return results;
    return { items: results, total, page: opts.page, limit: opts.limit ?? 25 };
  }

  /** Overview aggregate for the Organizations detail page's "Overview" tab —
   * the Users/Wallet/Ledger/Usage/Subscriptions/Payments/Invoices tabs reuse
   * the existing listTransactions/listPayments/etc. methods below, filtered
   * by this organizationId; no separate endpoint needed for those. */
  async getOrganizationDetail(organizationId: string) {
    const org = await this.orgModel.findById(organizationId).exec();
    if (!org) throw new NotFoundException('Organization not found.');

    const [userCount, walletSummary, subscription, purchaseRows, usageRows] = await Promise.all([
      this.userModel.countDocuments({ organizationId }).exec(),
      this.wallet.getSummary(organizationId, this.config.get<number>('billing.lowBalanceThresholdCredits') ?? 200),
      this.currentSubscriptionFor(organizationId),
      this.transactionModel
        .aggregate<{ credits: number }>([
          { $match: { organizationId, type: { $in: ['PURCHASE', 'AUTO_RECHARGE'] } } },
          { $group: { _id: null, credits: { $sum: '$amountCredits' } } },
        ])
        .exec(),
      this.transactionModel
        .aggregate<{ credits: number }>([
          { $match: { organizationId, type: 'AI_USAGE' } },
          { $group: { _id: null, credits: { $sum: { $abs: '$amountCredits' } } } },
        ])
        .exec(),
    ]);

    return {
      organizationId,
      name: org.name,
      slug: org.slug,
      status: org.status,
      createdAt: (org as unknown as { createdAt: Date }).createdAt,
      userCount,
      wallet: walletSummary,
      subscription,
      lifetimeRevenueUsd: this.pricing.creditsToUsd(purchaseRows[0]?.credits ?? 0),
      lifetimeCreditsUsed: usageRows[0]?.credits ?? 0,
    };
  }

  /** Users/tab on the organization detail page — same projection
   * UsersService.toPublic applies (never passwordHash/OTP fields), just
   * queryable for any org id rather than only the caller's own. */
  async listOrganizationUsers(organizationId: string) {
    const users = await this.userModel.find({ organizationId }).sort({ createdAt: -1 }).exec();
    // Same public projection UsersService.toPublic applies — never
    // passwordHash/OTP fields, and a plain `id` string instead of Mongo's _id.
    return users.map((u) => ({
      id: u._id.toString(),
      email: u.email,
      name: u.name,
      roles: u.roles,
      active: u.active,
      createdAt: (u as unknown as { createdAt: Date }).createdAt,
    }));
  }

  listTransactions(filters: {
    organizationId?: string;
    type?: string;
    limit?: number;
    skip?: number;
    dateFrom?: string;
    dateTo?: string;
    minAmount?: number;
    maxAmount?: number;
  }) {
    const query: Record<string, unknown> = {};
    if (filters.organizationId) query.organizationId = filters.organizationId;
    if (filters.type) query.type = filters.type;
    if (filters.dateFrom || filters.dateTo) {
      const range: Record<string, Date> = {};
      if (filters.dateFrom) range.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) range.$lte = new Date(filters.dateTo);
      query.createdAt = range;
    }
    if (filters.minAmount !== undefined || filters.maxAmount !== undefined) {
      const range: Record<string, number> = {};
      if (filters.minAmount !== undefined) range.$gte = filters.minAmount;
      if (filters.maxAmount !== undefined) range.$lte = filters.maxAmount;
      query.amountCredits = range;
    }
    return this.transactionModel
      .find(query)
      .sort({ createdAt: -1 })
      .skip(filters.skip ?? 0)
      .limit(filters.limit ?? 100)
      .exec();
  }

  listPayments(filters: {
    organizationId?: string;
    status?: string;
    provider?: string;
    limit?: number;
    skip?: number;
    dateFrom?: string;
    dateTo?: string;
  }) {
    const query: Record<string, unknown> = {};
    if (filters.organizationId) query.organizationId = filters.organizationId;
    if (filters.status) query.status = filters.status;
    if (filters.provider) query.provider = filters.provider;
    if (filters.dateFrom || filters.dateTo) {
      const range: Record<string, Date> = {};
      if (filters.dateFrom) range.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) range.$lte = new Date(filters.dateTo);
      query.createdAt = range;
    }
    return this.paymentRecordModel
      .find(query)
      .sort({ createdAt: -1 })
      .skip(filters.skip ?? 0)
      .limit(filters.limit ?? 100)
      .exec();
  }

  /** Read-only, paginated — a plain find()+skip/limit against the Wallet
   * collection, not new ledger logic. Available credits is always computed
   * on read (balanceCredits - reservedCredits), same as WalletService.getSummary. */
  async listWallets(filters: { search?: string; page?: number; limit?: number }) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 25;
    const query: Record<string, unknown> = { migratedAt: { $exists: false } };
    if (filters.search) {
      const escaped = filters.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.organizationId = { $regex: escaped, $options: 'i' };
    }
    const [wallets, total] = await Promise.all([
      this.walletModel.find(query).sort({ balanceCredits: -1 }).skip((page - 1) * limit).limit(limit).exec(),
      this.walletModel.countDocuments(query).exec(),
    ]);
    const orgIds = wallets.map((w) => w.organizationId);
    const orgs = await this.orgModel.find({ _id: { $in: orgIds } }, { name: 1 }).exec();
    const nameById = new Map(orgs.map((o) => [o._id.toString(), o.name]));

    const items = wallets.map((w) => ({
      organizationId: w.organizationId,
      organizationName: nameById.get(w.organizationId) ?? w.organizationId,
      walletId: w._id.toString(),
      balanceCredits: w.balanceCredits,
      reservedCredits: w.reservedCredits,
      availableCredits: w.balanceCredits - w.reservedCredits,
      autoPayEnabled: w.autoPay?.enabled ?? false,
    }));
    return { items, total, page, limit };
  }

  /** Single consolidated payload for the Dashboard's KPI tiles — everything
   * here is a pure read over collections getOverview/getSubscriptionMetrics
   * already aggregate, just combined with the handful of counts (active
   * orgs, total users, credits outstanding, auto-recharge activity) those
   * two methods don't already compute. */
  async getDashboard(days = 30): Promise<AdminDashboard> {
    const since = new Date(Date.now() - days * 86_400_000);

    const [
      totalOrganizations,
      activeOrganizations,
      totalUsers,
      activeSubscriptions,
      revenueRows,
      usageRows,
      successfulPaymentsCount,
      failedPaymentsCount,
      refundedPaymentsCount,
      outstandingRows,
      autoRechargeEnabledWallets,
      autoRechargeEventsInPeriod,
    ] = await Promise.all([
      this.orgModel.countDocuments().exec(),
      this.orgModel.countDocuments({ status: 'active' }).exec(),
      this.userModel.countDocuments().exec(),
      this.subscriptionModel.countDocuments({ status: 'active' }).exec(),
      this.transactionModel
        .aggregate<{ credits: number }>([
          { $match: { type: { $in: ['PURCHASE', 'AUTO_RECHARGE'] }, createdAt: { $gte: since } } },
          { $group: { _id: null, credits: { $sum: '$amountCredits' } } },
        ])
        .exec(),
      this.transactionModel
        .aggregate<{ credits: number }>([
          { $match: { type: 'AI_USAGE', createdAt: { $gte: since } } },
          { $group: { _id: null, credits: { $sum: { $abs: '$amountCredits' } } } },
        ])
        .exec(),
      this.paymentRecordModel.countDocuments({ status: 'captured', createdAt: { $gte: since } }).exec(),
      this.paymentRecordModel.countDocuments({ status: 'failed', createdAt: { $gte: since } }).exec(),
      this.paymentRecordModel.countDocuments({ status: { $in: ['refunded', 'partially_refunded'] }, createdAt: { $gte: since } }).exec(),
      this.walletModel
        .aggregate<{ outstanding: number }>([
          { $match: { migratedAt: { $exists: false } } },
          { $group: { _id: null, outstanding: { $sum: { $subtract: ['$balanceCredits', '$reservedCredits'] } } } },
        ])
        .exec(),
      this.walletModel.countDocuments({ 'autoPay.enabled': true }).exec(),
      this.transactionModel.countDocuments({ type: 'AUTO_RECHARGE', createdAt: { $gte: since } }).exec(),
    ]);

    return {
      days,
      totalOrganizations,
      activeOrganizations,
      totalUsers,
      activeSubscriptions,
      revenueUsd: this.pricing.creditsToUsd(revenueRows[0]?.credits ?? 0),
      successfulPaymentsCount,
      failedPaymentsCount,
      refundedPaymentsCount,
      creditsSold: revenueRows[0]?.credits ?? 0,
      creditsUsed: usageRows[0]?.credits ?? 0,
      creditsOutstanding: outstandingRows[0]?.outstanding ?? 0,
      autoRechargeEnabledWallets,
      autoRechargeEventsInPeriod,
    };
  }

  /** Day-bucketed series for the Analytics page's charts — same source
   * collections as getDashboard/getSubscriptionMetrics, just grouped by
   * calendar day via $dateToString instead of summed over the whole window. */
  async getAnalyticsTimeSeries(days = 30): Promise<AdminAnalytics> {
    const since = new Date(Date.now() - days * 86_400_000);
    const dayFormat = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };

    const toSeries = (rows: { _id: string; value: number }[]): AnalyticsSeriesPoint[] =>
      rows.map((r) => ({ date: r._id, value: r.value })).sort((a, b) => a.date.localeCompare(b.date));

    const [revenueRows, usageRows, newOrgRows, newSubRows, paymentSuccessRows, paymentFailureRows, activeSubscriptions] =
      await Promise.all([
        this.transactionModel
          .aggregate<{ _id: string; value: number }>([
            { $match: { type: { $in: ['PURCHASE', 'AUTO_RECHARGE'] }, createdAt: { $gte: since } } },
            { $group: { _id: dayFormat, value: { $sum: '$amountCredits' } } },
          ])
          .exec(),
        this.transactionModel
          .aggregate<{ _id: string; value: number }>([
            { $match: { type: 'AI_USAGE', createdAt: { $gte: since } } },
            { $group: { _id: dayFormat, value: { $sum: { $abs: '$amountCredits' } } } },
          ])
          .exec(),
        this.orgModel
          .aggregate<{ _id: string; value: number }>([
            { $match: { createdAt: { $gte: since } } },
            { $group: { _id: dayFormat, value: { $sum: 1 } } },
          ])
          .exec(),
        this.eventModel
          .aggregate<{ _id: string; value: number }>([
            { $match: { type: 'created', createdAt: { $gte: since } } },
            { $group: { _id: dayFormat, value: { $sum: 1 } } },
          ])
          .exec(),
        this.paymentRecordModel
          .aggregate<{ _id: string; value: number }>([
            { $match: { status: 'captured', createdAt: { $gte: since } } },
            { $group: { _id: dayFormat, value: { $sum: 1 } } },
          ])
          .exec(),
        this.paymentRecordModel
          .aggregate<{ _id: string; value: number }>([
            { $match: { status: 'failed', createdAt: { $gte: since } } },
            { $group: { _id: dayFormat, value: { $sum: 1 } } },
          ])
          .exec(),
        this.subscriptionModel.find({ status: 'active' }, { planId: 1 }).exec(),
      ]);

    const planIds = [...new Set(activeSubscriptions.map((s) => s.planId))];
    const plans = planIds.length > 0 ? await this.planModel.find({ _id: { $in: planIds } }, { name: 1 }).exec() : [];
    const nameByPlanId = new Map(plans.map((p) => [p._id.toString(), p.name]));
    const countByPlan = new Map<string, number>();
    for (const sub of activeSubscriptions) {
      const name = nameByPlanId.get(sub.planId) ?? 'Unknown plan';
      countByPlan.set(name, (countByPlan.get(name) ?? 0) + 1);
    }

    return {
      days,
      revenueSeries: toSeries(revenueRows).map((p) => ({ date: p.date, value: this.pricing.creditsToUsd(p.value) })),
      creditUsageSeries: toSeries(usageRows),
      newOrganizationsSeries: toSeries(newOrgRows),
      subscriptionGrowthSeries: toSeries(newSubRows),
      paymentSuccessSeries: toSeries(paymentSuccessRows),
      paymentFailureSeries: toSeries(paymentFailureRows),
      planDistribution: [...countByPlan.entries()].map(([planName, count]) => ({ planName, count })),
    };
  }
}
