import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AiUsageHierarchyService } from '../ai-usage/ai-usage-hierarchy.service';
import { PricingService } from '../billing/pricing.service';
import { EncryptionService } from '../common/encryption/encryption.service';
import { WalletTransaction, WalletTransactionDocument } from '../billing/schemas/wallet-transaction.schema';
import { IntegrationCredential, IntegrationCredentialDocument } from '../integrations/schemas/integration-credential.schema';
import { ProviderFinanceAdapterRegistry } from './adapters/provider-finance-adapter.registry';
import { CapabilityMatrix, ProviderCapability } from './adapters/provider-capability-adapter.interface';
import { RecordPaymentDto } from './dto/record-payment.dto';
import { UpsertProviderAccountDto } from './dto/upsert-provider-account.dto';
import { REPORTING_TIMEZONE, startOfMonthIst } from './reporting-timezone';
import { ProviderAccount, ProviderAccountDocument } from './schemas/provider-account.schema';
import { ProviderPayment, ProviderPaymentDocument } from './schemas/provider-payment.schema';

// Every real LLM provider this app actually connects today (see
// integrations.service.ts's PLATFORM_PROVIDERS — Sarvam/ElevenLabs are
// voice/STT, not text LLMs, so left out of provider *finance* tracking).
// A provider added here later needs nothing more than a new adapter
// registered in ProviderFinanceAdapterRegistry — no other architecture change.
export const FINANCE_TRACKED_PROVIDERS = ['anthropic', 'groq'] as const;

// The one place "the next hourly cron tick" is computed — EVERY_HOUR fires
// on the hour, so this is exact, not a fabricated estimate.
const SYNC_INTERVAL_MS = 60 * 60 * 1000;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface ListPaymentsFilters {
  provider?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: 'recorded' | 'confirmed' | 'disputed';
  currency?: string;
  page: number;
  pageSize: number;
}

// Platform expenditure/balance/payment tracking for LLM providers —
// deliberately separate from customer organisation wallets
// (billing/wallet.service.ts), which this module only ever READS from
// (WalletTransaction for revenue, IntegrationCredential for "is this
// provider actually connected") and never writes to.
//
// Balance is NEVER a typed-in number here (see provider-account.schema.ts's
// own comment and adapters/*.ts) — it's an honest capability status, since
// neither Anthropic nor Groq expose a balance-read API at all. What IS real:
// Haive's own tracked consumption (agent_executions, via
// AiUsageHierarchyService) compared against an admin-set monthlyBudget, and
// — for Anthropic, once an Admin API key is configured — the provider's OWN
// reported cost, synced hourly (see ProviderUsageCostSyncService).
//
// Five DELIBERATELY SEPARATE concepts live on every account view — collapsing
// them into one "active" flag is exactly the bug that made Active Providers
// read 0 even with a working Admin API key configured:
//   - `connected`      — a real platform IntegrationCredential (chat apiKey) is on file.
//   - `status`         — operational health for AI *requests* (unrelated to finance).
//   - `hasAdminApiKey` — a finance-tier credential is configured (not proof it's valid).
//   - `usageCostSync.lastSuccessAt`/`lastError` — whether the finance API call actually authenticated and worked.
//   - capability status — what this provider's API can even support, independent of all of the above.
@Injectable()
export class ProviderFinanceService {
  constructor(
    @InjectModel(ProviderAccount.name) private accountModel: Model<ProviderAccountDocument>,
    @InjectModel(ProviderPayment.name) private paymentModel: Model<ProviderPaymentDocument>,
    @InjectModel(WalletTransaction.name) private transactionModel: Model<WalletTransactionDocument>,
    @InjectModel(IntegrationCredential.name) private credentialModel: Model<IntegrationCredentialDocument>,
    private hierarchy: AiUsageHierarchyService,
    private adapters: ProviderFinanceAdapterRegistry,
    private encryption: EncryptionService,
    private pricing: PricingService,
  ) {}

  // ---- Accounts -----------------------------------------------------------

  async getAccounts() {
    const docs = await this.accountModel.find().exec();
    const byProvider = new Map(docs.map((d) => [d.provider, d]));
    // Every tracked provider always appears, even before an admin has ever
    // configured it — honestly shown as 'unknown' rather than simply
    // missing from the list.
    return Promise.all(FINANCE_TRACKED_PROVIDERS.map((provider) => this.toAccountView(byProvider.get(provider) ?? null, provider)));
  }

  async getAccount(provider: string) {
    const doc = await this.accountModel.findOne({ provider }).exec();
    return this.toAccountView(doc, provider);
  }

  private async toAccountView(doc: ProviderAccountDocument | null, provider: string) {
    const adapter = this.adapters.get(provider);
    const capabilities: CapabilityMatrix | null = adapter ? adapter.getCapabilities({ adminApiKeyEncrypted: doc?.adminApiKeyEncrypted }) : null;
    const balanceCapability = capabilities?.[ProviderCapability.BALANCE_READ];

    const periodStart = startOfMonthIst();
    const periodEnd = new Date();
    const [consumptionThisMonthRaw, connected] = await Promise.all([
      this.hierarchy.getProviderCostSince(provider, periodStart),
      this.credentialModel.exists({ organizationId: 'platform', provider }).then((r) => !!r),
    ]);
    const consumptionThisMonth = round2(consumptionThisMonthRaw);
    const monthlyBudget = doc?.monthlyBudget ?? null;
    const budgetPacePct = monthlyBudget ? round2((consumptionThisMonth / monthlyBudget) * 100) : null;

    const providerReportedCostThisMonth = doc?.lastProviderReportedCostThisMonth ?? null;
    const costVariancePct =
      providerReportedCostThisMonth != null && consumptionThisMonth > 0 ? round2(((providerReportedCostThisMonth - consumptionThisMonth) / consumptionThisMonth) * 100) : null;

    const usageCostReadSupported = capabilities?.[ProviderCapability.USAGE_COST_READ]?.status === 'SUPPORTED';
    // null = "never attempted" (nothing to judge authentication/sync health
    // from yet) — never defaults to true/false without real evidence.
    const lastSyncSuccessful = doc?.lastUsageCostSyncAttemptedAt == null ? null : doc.lastUsageCostSyncError == null;

    return {
      provider,
      accountIdentifier: doc?.accountIdentifier ?? null,
      // Operational health for AI *requests* — unrelated to finance/billing
      // capability. 'unknown'/'active'/'degraded' are all non-exhausted;
      // only a confirmed exhaustion (python-agent, or an admin) excludes a
      // provider from being counted as operational.
      status: doc?.status ?? 'unknown',
      operational: (doc?.status ?? 'unknown') !== 'exhausted',
      // Whether a real chat-completion credential is on file for this
      // provider at all (IntegrationsService/AdminIntegrationsController) —
      // completely independent of finance capability or sync health. A
      // provider can be connected (usable for AI requests) with zero
      // finance tracking configured, and vice versa.
      connected,
      accountType: doc?.accountType ?? 'balance-unavailable',
      currency: doc?.currency ?? 'USD',
      // Never a number — balance is a capability status for every real
      // provider today. See this module's own class comment for why.
      balance: {
        status: balanceCapability?.status ?? 'UNSUPPORTED',
        note: balanceCapability?.detail ?? "Not exposed by this provider's API.",
      },
      monthlyBudget,
      // Calendar month-to-date, Asia/Kolkata — see reporting-timezone.ts.
      // periodStart/periodEnd are included explicitly so the frontend never
      // has to guess what window this number covers (the root cause behind
      // it looking "contradictory" next to a differently-windowed figure
      // elsewhere on the same page).
      consumptionThisMonth,
      consumptionPeriod: { start: periodStart, end: periodEnd, timezone: REPORTING_TIMEZONE },
      budgetPacePct,
      hasAdminApiKey: !!doc?.adminApiKeyEncrypted,
      capabilities,
      usageCostSync: {
        // "Last successful" — distinct from "last attempted" below. Neither
        // is ever cleared by a failed attempt; see syncUsageCostForProvider.
        lastSuccessAt: doc?.lastUsageCostSyncAt ?? null,
        lastAttemptedAt: doc?.lastUsageCostSyncAttemptedAt ?? null,
        lastError: doc?.lastUsageCostSyncError ?? null,
        // null = never attempted; true/false = the most recent attempt's
        // real outcome. This IS the "finance API authenticated" signal —
        // there is no separate, cheaper way to know a key is valid without
        // actually calling the API with it.
        lastAttemptSuccessful: lastSyncSuccessful,
        providerReportedCostThisMonth,
        costVariancePct,
        nextScheduledSyncAt: usageCostReadSupported ? new Date(Math.ceil(Date.now() / SYNC_INTERVAL_MS) * SYNC_INTERVAL_MS) : null,
      },
      alertRecipients: doc?.alertRecipients ?? [],
    };
  }

  async upsertAccount(provider: string, dto: UpsertProviderAccountDto) {
    await this.accountModel.updateOne({ provider }, { $set: dto, $setOnInsert: { provider } }, { upsert: true }).exec();
    return this.getAccount(provider);
  }

  async setAdminApiKey(provider: string, adminApiKey: string) {
    if (!(FINANCE_TRACKED_PROVIDERS as readonly string[]).includes(provider)) {
      throw new BadRequestException(`Unknown provider "${provider}".`);
    }
    await this.accountModel
      .updateOne({ provider }, { $set: { adminApiKeyEncrypted: this.encryption.encrypt(adminApiKey) }, $setOnInsert: { provider } }, { upsert: true })
      .exec();
    return this.getAccount(provider);
  }

  async clearAdminApiKey(provider: string) {
    const updated = await this.accountModel.findOneAndUpdate({ provider }, { $unset: { adminApiKeyEncrypted: '' } }, { new: true }).exec();
    if (!updated) throw new NotFoundException(`Unknown provider "${provider}".`);
    return this.getAccount(provider);
  }

  // ---- Payments -------------------------------------------------------------

  async recordPayment(dto: RecordPaymentDto, adminId: string) {
    if (dto.transactionId) {
      const existing = await this.paymentModel.findOne({ provider: dto.provider, transactionId: dto.transactionId }).exec();
      if (existing) throw new BadRequestException(`A payment with transaction id "${dto.transactionId}" is already recorded for ${dto.provider}.`);
    }
    return this.paymentModel.create({
      provider: dto.provider,
      amount: dto.amount,
      currency: dto.currency ?? 'USD',
      paymentDate: new Date(dto.paymentDate),
      paymentMethod: dto.paymentMethod,
      transactionId: dto.transactionId,
      invoiceNumber: dto.invoiceNumber,
      creditPurchased: dto.creditPurchased,
      taxAmount: dto.taxAmount,
      feeAmount: dto.feeAmount,
      status: dto.status ?? 'recorded',
      recordedByAdminId: adminId,
      notes: dto.notes,
    });
  }

  async attachReceipt(paymentId: string, fileId: string, filename: string, mimeType: string) {
    const payment = await this.paymentModel.findById(paymentId).exec();
    if (!payment) throw new NotFoundException('Payment not found.');
    payment.receiptFileId = fileId;
    payment.receiptFileName = filename;
    payment.receiptFileMimeType = mimeType;
    await payment.save();
    return payment;
  }

  async getPaymentReceipt(paymentId: string) {
    const payment = await this.paymentModel.findById(paymentId, { receiptFileId: 1, receiptFileName: 1, receiptFileMimeType: 1 }).exec();
    if (!payment?.receiptFileId) throw new NotFoundException('This payment has no receipt attached.');
    return { fileId: payment.receiptFileId, filename: payment.receiptFileName ?? 'receipt', mimeType: payment.receiptFileMimeType ?? 'application/octet-stream' };
  }

  async listPayments(filters: ListPaymentsFilters) {
    const match: Record<string, unknown> = {};
    if (filters.provider) match.provider = filters.provider;
    if (filters.status) match.status = filters.status;
    if (filters.currency) match.currency = filters.currency;
    if (filters.dateFrom || filters.dateTo) {
      match.paymentDate = {
        ...(filters.dateFrom ? { $gte: new Date(`${filters.dateFrom}T00:00:00.000Z`) } : {}),
        ...(filters.dateTo ? { $lte: new Date(`${filters.dateTo}T23:59:59.999Z`) } : {}),
      };
    }
    const skip = (filters.page - 1) * filters.pageSize;
    const [items, total] = await Promise.all([
      this.paymentModel.find(match).sort({ paymentDate: -1 }).skip(skip).limit(filters.pageSize).exec(),
      this.paymentModel.countDocuments(match).exec(),
    ]);
    return { items, total, page: filters.page, pageSize: filters.pageSize };
  }

  async getPaymentTotals(by: 'provider' | 'month' | 'year') {
    const groupId =
      by === 'provider'
        ? '$provider'
        : by === 'month'
          ? { $dateToString: { format: '%Y-%m', date: '$paymentDate', timezone: REPORTING_TIMEZONE } }
          : { $dateToString: { format: '%Y', date: '$paymentDate', timezone: REPORTING_TIMEZONE } };
    const rows = await this.paymentModel
      .aggregate<{ _id: string; total: number; count: number }>([{ $group: { _id: groupId, total: { $sum: '$amount' }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }])
      .exec();
    return rows.map((r) => ({ key: r._id, total: round2(r.total), count: r.count }));
  }

  // ---- Usage-cost sync (called by ProviderUsageCostSyncService) -----------

  /** Pulls the provider's own reported cost-to-date-this-month, when (and
   * only when) its adapter reports USAGE_COST_READ as SUPPORTED for this
   * account's current configuration — a no-op otherwise, never a guess.
   * Retry/backoff/pagination all live inside the adapter itself; this just
   * records the outcome (success or a surfaced error) on the account doc.
   *
   * lastUsageCostSyncAttemptedAt is updated on EVERY call (success or
   * failure) — lastUsageCostSyncAt and lastProviderReportedCostThisMonth
   * are updated ONLY on success, so a failed attempt can never overwrite a
   * previously-successful financial figure with a zero or a stale error
   * state masquerading as current data. */
  async syncUsageCostForProvider(provider: string): Promise<void> {
    const doc = await this.accountModel.findOne({ provider }).exec();
    const adapter = this.adapters.get(provider);
    if (!doc || !adapter?.syncUsageCost) return;

    const capabilities = adapter.getCapabilities({ adminApiKeyEncrypted: doc.adminApiKeyEncrypted });
    if (capabilities[ProviderCapability.USAGE_COST_READ].status !== 'SUPPORTED') return;

    doc.lastUsageCostSyncAttemptedAt = new Date();
    try {
      const adminApiKey = this.encryption.decrypt(doc.adminApiKeyEncrypted!);
      // Same IST month boundary consumptionThisMonth uses — so the
      // provider-reported-vs-Haive-tracked variance check compares two
      // figures over the identical window, not two different ones.
      const report = await adapter.syncUsageCost(adminApiKey, startOfMonthIst());
      doc.lastUsageCostSyncAt = new Date();
      doc.lastUsageCostSyncError = null;
      doc.lastProviderReportedCostThisMonth = round2(report.totalCostUsd);
    } catch (err) {
      doc.lastUsageCostSyncError = (err as Error).message.slice(0, 500);
      // Deliberately untouched on failure: lastUsageCostSyncAt and
      // lastProviderReportedCostThisMonth keep their last-known-good value.
    }
    await doc.save();
  }

  // ---- Dashboard / reports --------------------------------------------------

  async getFinanceDashboard(days: number) {
    const since = new Date(Date.now() - days * 86_400_000);

    const accounts = await this.getAccounts();

    const totalPaymentsRows = await this.paymentModel.aggregate<{ total: number }>([{ $match: { paymentDate: { $gte: since } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]).exec();
    const lastPaymentRows = await this.paymentModel.find().sort({ paymentDate: -1 }).limit(1).exec();

    const totalConsumptionThisMonth = round2(accounts.reduce((sum, a) => sum + a.consumptionThisMonth, 0));

    const nearOrOverBudgetProviders = accounts.filter((a) => a.budgetPacePct != null && a.budgetPacePct >= 80);
    const exhaustedProviders = accounts.filter((a) => a.status === 'exhausted');
    const needsConfigurationProviders = accounts.filter((a) => Object.values(a.capabilities ?? {}).some((c) => c.status === 'CONFIGURATION_REQUIRED' || c.status === 'PERMISSION_REQUIRED'));

    // Average gap between consecutive payments — a labeled ESTIMATE, never
    // a promise, per the spec's own "do not fabricate" rule. Absent when
    // fewer than 2 payments exist (nothing to average yet).
    const allPaymentDates = await this.paymentModel.find({}, { paymentDate: 1 }).sort({ paymentDate: 1 }).exec();
    let nextExpectedRechargeDate: Date | null = null;
    if (allPaymentDates.length >= 2) {
      const gaps: number[] = [];
      for (let i = 1; i < allPaymentDates.length; i += 1) gaps.push(allPaymentDates[i].paymentDate.getTime() - allPaymentDates[i - 1].paymentDate.getTime());
      const avgGapMs = gaps.reduce((sum, g) => sum + g, 0) / gaps.length;
      nextExpectedRechargeDate = new Date(allPaymentDates[allPaymentDates.length - 1].paymentDate.getTime() + avgGapMs);
    }

    return {
      days,
      periodStart: since,
      periodEnd: new Date(),
      totalPaymentsInRange: round2(totalPaymentsRows[0]?.total ?? 0),
      // Calendar month-to-date (Asia/Kolkata) — see each account's own
      // consumptionPeriod for the exact window; deliberately NOT the same
      // `days`-trailing window `getProfitability` below uses, so the two are
      // never silently conflated as "the same period" again.
      totalConsumptionThisMonth,
      // "Connected AND not confirmed-exhausted" — NOT a literal `status ===
      // 'active'` check. Nothing in this app ever writes the literal
      // 'active' enum value (only python-agent's mark_exhausted ever writes
      // 'exhausted'; 'active'/'degraded' are otherwise unused today), so
      // that check always read 0 regardless of real provider health. See
      // this module's own class comment for why these are separate signals.
      activeProviderCount: accounts.filter((a) => a.connected && a.operational).length,
      nearOrOverBudgetProviderCount: nearOrOverBudgetProviders.length,
      exhaustedProviderCount: exhaustedProviders.length,
      needsConfigurationProviderCount: needsConfigurationProviders.length,
      lastPaymentDate: lastPaymentRows[0]?.paymentDate ?? null,
      // Explicitly an estimate derived from payment cadence, never a
      // guarantee — surfaced as such in the API shape's own field name.
      nextExpectedRechargeDateEstimate: nextExpectedRechargeDate,
      accounts,
    };
  }

  async getProfitability(days: number) {
    const since = new Date(Date.now() - days * 86_400_000);

    const [revenueRows, costPerProvider] = await Promise.all([
      this.transactionModel
        .aggregate<{ _id: string; revenue: number }>([
          { $match: { type: 'AI_USAGE', createdAt: { $gte: since } } },
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: REPORTING_TIMEZONE } }, revenue: { $sum: { $abs: '$amountCredits' } } } },
          { $sort: { _id: 1 } },
        ])
        .exec(),
      Promise.all(FINANCE_TRACKED_PROVIDERS.map((p) => this.hierarchy.getProviderCostSince(p, since))),
    ]);

    const totalRevenueCredits = revenueRows.reduce((sum, r) => sum + r.revenue, 0);
    const totalProviderCostUsd = costPerProvider.reduce((sum, c) => sum + c, 0);

    // Gross profit/margin — reuses PricingService.creditsToUsd(), the SAME
    // USD<->credits bridge (config.billing.usdToCurrencyRate, default 83;
    // the 1-Credit-= ₹1 peg) ReservationService.settle() and every existing
    // billing report already use. Converts credits -> USD first, so this
    // never adds a credits figure and a USD figure directly (the bug this
    // metric previously avoided only by not computing a margin at all).
    const totalRevenueUsd = round2(this.pricing.creditsToUsd(totalRevenueCredits));
    const grossProfitUsd = round2(totalRevenueUsd - totalProviderCostUsd);
    const grossMarginPct = totalRevenueUsd > 0 ? round2((grossProfitUsd / totalRevenueUsd) * 100) : null;

    return {
      days,
      periodStart: since,
      periodEnd: new Date(),
      // Credits — Haive's own wallet currency, shown alongside its USD
      // equivalent (reportingCurrency names which conversion was applied)
      // rather than silently converted away.
      totalRevenueCredits: round2(totalRevenueCredits),
      totalRevenueUsd,
      totalProviderCostUsd: round2(totalProviderCostUsd),
      grossProfitUsd,
      grossMarginPct,
      reportingCurrency: 'USD',
      providerCostBreakdown: FINANCE_TRACKED_PROVIDERS.map((p, i) => ({ provider: p, costUsd: round2(costPerProvider[i]) })),
      dailyRevenueSeries: revenueRows.map((r) => ({ date: r._id, revenueCredits: round2(r.revenue) })),
      // Recharge payments are deliberately excluded from this cost side —
      // they move provider-account balance, not consumption (spec section
      // 9's own "avoid treating recharge payments as consumption costs").
    };
  }
}
