import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AiUsageHierarchyService } from '../ai-usage/ai-usage-hierarchy.service';
import { WalletTransaction, WalletTransactionDocument } from '../billing/schemas/wallet-transaction.schema';
import { RecordPaymentDto } from './dto/record-payment.dto';
import { RecordReconciliationDto } from './dto/record-reconciliation.dto';
import { UpsertProviderAccountDto } from './dto/upsert-provider-account.dto';
import { ProviderAccount, ProviderAccountDocument } from './schemas/provider-account.schema';
import { ProviderPayment, ProviderPaymentDocument } from './schemas/provider-payment.schema';

// Every real LLM provider this app actually connects today (see
// integrations.service.ts's PLATFORM_PROVIDERS — Sarvam/ElevenLabs are
// voice/STT, not text LLMs, so left out of provider *finance* tracking).
// A provider added here later needs nothing more than a new
// upsertAccount() call — no architecture change.
export const FINANCE_TRACKED_PROVIDERS = ['anthropic', 'groq'] as const;

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
// (WalletTransaction, for the revenue side of getProfitability) and never
// writes to. See this feature's plan/schema comments for why
// confirmedBalance is manual-only: neither Anthropic nor Groq expose a real
// balance-check API today.
@Injectable()
export class ProviderFinanceService {
  constructor(
    @InjectModel(ProviderAccount.name) private accountModel: Model<ProviderAccountDocument>,
    @InjectModel(ProviderPayment.name) private paymentModel: Model<ProviderPaymentDocument>,
    @InjectModel(WalletTransaction.name) private transactionModel: Model<WalletTransactionDocument>,
    private hierarchy: AiUsageHierarchyService,
  ) {}

  // ---- Accounts -----------------------------------------------------------

  async getAccounts() {
    const docs = await this.accountModel.find().exec();
    const byProvider = new Map(docs.map((d) => [d.provider, d]));
    // Every tracked provider always appears, even before an admin has ever
    // configured it — honestly shown as 'unknown'/'balance-unavailable'
    // rather than simply missing from the list.
    return Promise.all(FINANCE_TRACKED_PROVIDERS.map((provider) => this.toAccountView(byProvider.get(provider) ?? null, provider)));
  }

  async getAccount(provider: string) {
    const doc = await this.accountModel.findOne({ provider }).exec();
    return this.toAccountView(doc, provider);
  }

  private async toAccountView(doc: ProviderAccountDocument | null, provider: string) {
    const lastReconciledAt = doc?.lastReconciledAt ?? null;
    const confirmedBalance = doc?.confirmedBalance ?? null;
    // Estimated balance is ALWAYS derived here, never stored — see this
    // module's own schema comment on why. Absent entirely until an admin
    // has reconciled at least once, since there is no honest starting point
    // before that (never defaults to 0, which would read as "exhausted").
    let estimatedBalance: number | null = null;
    if (confirmedBalance != null && lastReconciledAt) {
      const costSince = await this.hierarchy.getProviderCostSince(provider, lastReconciledAt);
      estimatedBalance = round2(confirmedBalance - costSince);
    }

    return {
      provider,
      accountIdentifier: doc?.accountIdentifier ?? null,
      status: doc?.status ?? 'unknown',
      accountType: doc?.accountType ?? 'balance-unavailable',
      currency: doc?.currency ?? 'USD',
      confirmedBalance,
      estimatedBalance,
      lastReconciledAt,
      lastReconciledByAdminId: doc?.lastReconciledByAdminId ?? null,
      monthlyBudget: doc?.monthlyBudget ?? null,
      lowThresholdPct: doc?.lowThresholdPct ?? 25,
      criticalThresholdPct: doc?.criticalThresholdPct ?? 10,
      zeroBalanceAction: doc?.zeroBalanceAction ?? 'alert-only',
      alertRecipients: doc?.alertRecipients ?? [],
    };
  }

  async upsertAccount(provider: string, dto: UpsertProviderAccountDto) {
    await this.accountModel.updateOne({ provider }, { $set: dto, $setOnInsert: { provider } }, { upsert: true }).exec();
    return this.getAccount(provider);
  }

  async recordReconciliation(provider: string, dto: RecordReconciliationDto, adminId: string) {
    const updated = await this.accountModel
      .findOneAndUpdate(
        { provider },
        {
          $set: {
            confirmedBalance: dto.confirmedBalance,
            lastReconciledAt: new Date(),
            lastReconciledByAdminId: adminId,
            // A fresh reconciliation is new, better information — the
            // previous alert state no longer describes the current
            // balance, same "recovery resets the dedup state" rule Phase
            // B's own design relies on.
            lastAlertedThresholdPct: null,
          },
          $setOnInsert: { provider },
        },
        { upsert: true, new: true },
      )
      .exec();
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
    const groupId = by === 'provider' ? '$provider' : by === 'month' ? { $dateToString: { format: '%Y-%m', date: '$paymentDate' } } : { $dateToString: { format: '%Y', date: '$paymentDate' } };
    const rows = await this.paymentModel
      .aggregate<{ _id: string; total: number; count: number }>([{ $group: { _id: groupId, total: { $sum: '$amount' }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }])
      .exec();
    return rows.map((r) => ({ key: r._id, total: round2(r.total), count: r.count }));
  }

  // ---- Dashboard / reports --------------------------------------------------

  async getFinanceDashboard(days: number) {
    const since = new Date(Date.now() - days * 86_400_000);
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfYear = new Date(now.getFullYear(), 0, 1);

    const accounts = await this.getAccounts();

    const [totalPaymentsRows, lastPaymentRows, ...consumption] = await Promise.all([
      this.paymentModel.aggregate<{ total: number }>([{ $match: { paymentDate: { $gte: since } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]).exec(),
      this.paymentModel.find().sort({ paymentDate: -1 }).limit(1).exec(),
      ...FINANCE_TRACKED_PROVIDERS.flatMap((p) => [this.hierarchy.getProviderCostSince(p, startOfMonth), this.hierarchy.getProviderCostSince(p, startOfYear)]),
    ]);

    const consumptionByProvider = new Map<string, { month: number; year: number }>();
    FINANCE_TRACKED_PROVIDERS.forEach((p, i) => {
      consumptionByProvider.set(p, { month: consumption[i * 2] as number, year: consumption[i * 2 + 1] as number });
    });

    const totalExpenditureThisYear = [...consumptionByProvider.values()].reduce((sum, c) => sum + c.year, 0);
    const totalConsumptionThisMonth = [...consumptionByProvider.values()].reduce((sum, c) => sum + c.month, 0);

    const lowBalanceProviders = accounts.filter((a) => a.estimatedBalance != null && a.estimatedBalance / (a.confirmedBalance || 1) <= a.lowThresholdPct / 100);
    const exhaustedProviders = accounts.filter((a) => a.status === 'exhausted' || (a.estimatedBalance != null && a.estimatedBalance <= 0));

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
      totalExpenditureThisYear: round2(totalExpenditureThisYear),
      totalPaymentsInRange: round2(totalPaymentsRows[0]?.total ?? 0),
      totalConsumptionThisMonth: round2(totalConsumptionThisMonth),
      activeProviderCount: accounts.filter((a) => a.status === 'active').length,
      lowBalanceProviderCount: lowBalanceProviders.length,
      exhaustedProviderCount: exhaustedProviders.length,
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
          { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, revenue: { $sum: { $abs: '$amountCredits' } } } },
          { $sort: { _id: 1 } },
        ])
        .exec(),
      Promise.all(FINANCE_TRACKED_PROVIDERS.map((p) => this.hierarchy.getProviderCostSince(p, since))),
    ]);

    const totalRevenueCredits = revenueRows.reduce((sum, r) => sum + r.revenue, 0);
    const totalProviderCostUsd = costPerProvider.reduce((sum, c) => sum + c, 0);

    return {
      days,
      // Credits, not USD — this is Haive's own wallet currency; converting
      // to USD would need the same pricing.service.ts rate every other
      // billing report already uses, deliberately left to the caller rather
      // than guessed here.
      totalRevenueCredits: round2(totalRevenueCredits),
      totalProviderCostUsd: round2(totalProviderCostUsd),
      providerCostBreakdown: FINANCE_TRACKED_PROVIDERS.map((p, i) => ({ provider: p, costUsd: round2(costPerProvider[i]) })),
      dailyRevenueSeries: revenueRows.map((r) => ({ date: r._id, revenueCredits: round2(r.revenue) })),
      // Recharge payments are deliberately excluded from this cost side —
      // they move provider-account balance, not consumption (spec section
      // 9's own "avoid treating recharge payments as consumption costs").
    };
  }
}
