import { Cron, CronExpression } from '@nestjs/schedule';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AiUsageHierarchyService } from '../ai-usage/ai-usage-hierarchy.service';
import { AdminAccount, AdminAccountDocument } from '../auth/schemas/admin-account.schema';
import { MailService } from '../mail/mail.service';
import { ProviderFinanceAdapterRegistry } from './adapters/provider-finance-adapter.registry';
import { ProviderCapability } from './adapters/provider-capability-adapter.interface';
import { FINANCE_TRACKED_PROVIDERS, ProviderFinanceService } from './provider-finance.service';
import { startOfDayIst } from './reporting-timezone';
import { ProviderAlertLog, ProviderAlertLogDocument } from './schemas/provider-alert-log.schema';
import { ProviderAccount, ProviderAccountDocument } from './schemas/provider-account.schema';
import { ProviderPayment, ProviderPaymentDocument } from './schemas/provider-payment.schema';

const BUDGET_TIERS = [50, 80, 100];
const SPEND_SPIKE_MULTIPLIER = 3;
const COST_VARIANCE_ALERT_PCT = 20;
const SYNC_STALE_HOURS = 6;

// Cron-driven alerting for LLM provider finance — same @Cron(CronExpression...)
// pattern billing/subscription-renewal.service.ts already uses. There is no
// balance to compute a % against any more (see provider-account.schema.ts's
// own comment on why that was removed), so every check here compares REAL,
// computed numbers: `status` transitions (confirmed-exhaustion, written by
// python-agent's provider_account_status.mark_exhausted — never guessed),
// consumption-to-date vs an admin-set monthlyBudget, and (where available)
// the provider's own reported cost vs Haive's tracked cost. Every alert this
// sends is also logged to ProviderAlertLog for the dashboard's history feed.
@Injectable()
export class ProviderAlertService {
  private readonly logger = new Logger(ProviderAlertService.name);

  constructor(
    @InjectModel(ProviderAccount.name) private accountModel: Model<ProviderAccountDocument>,
    @InjectModel(AdminAccount.name) private adminModel: Model<AdminAccountDocument>,
    @InjectModel(ProviderAlertLog.name) private alertLogModel: Model<ProviderAlertLogDocument>,
    @InjectModel(ProviderPayment.name) private paymentModel: Model<ProviderPaymentDocument>,
    private finance: ProviderFinanceService,
    private adapters: ProviderFinanceAdapterRegistry,
    private hierarchy: AiUsageHierarchyService,
    private mail: MailService,
  ) {}

  private async resolveRecipients(account: ProviderAccountDocument): Promise<string[]> {
    if (account.alertRecipients?.length) return account.alertRecipients;
    const admins = await this.adminModel.find({ active: true }, { email: 1 }).exec();
    return admins.map((a) => a.email);
  }

  private async send(doc: ProviderAccountDocument, alertType: string, title: string, message: string): Promise<void> {
    const recipients = await this.resolveRecipients(doc);
    this.logger.warn(`[${doc.provider}] ${alertType}: ${title}`);
    await Promise.all(recipients.map((email) => this.mail.sendNotificationEmail(email, title, message)));
    await this.alertLogModel.create({ provider: doc.provider, alertType, title, message });
  }

  /** Dashboard's "recent alerts" feed — the log is the only place history
   * survives; current ProviderAccount fields only ever show the LATEST
   * state, never what fired and when. */
  async listRecentAlerts(limit = 20) {
    return this.alertLogModel.find().sort({ createdAt: -1 }).limit(limit).exec();
  }

  @Cron(CronExpression.EVERY_HOUR)
  async checkThresholds(): Promise<void> {
    for (const provider of FINANCE_TRACKED_PROVIDERS) {
      try {
        await this.checkOneProvider(provider);
      } catch (err) {
        this.logger.error(`Threshold check failed for ${provider}: ${(err as Error).message}`);
      }
    }
  }

  private async checkOneProvider(provider: string): Promise<void> {
    const doc = await this.accountModel.findOne({ provider }).exec();
    if (!doc) return;

    await this.checkExhaustionTransition(doc);
    await this.checkBudgetPace(doc);
    await this.checkUsageCostSyncHealth(doc);
    await this.checkCostVariance(doc);
    await this.checkSpendSpike(doc);
  }

  // ---- 1/2: confirmed exhaustion + recovery ---------------------------------

  private async checkExhaustionTransition(doc: ProviderAccountDocument): Promise<void> {
    if (doc.status === doc.lastAlertedStatus) return;
    const previous = doc.lastAlertedStatus;
    doc.lastAlertedStatus = doc.status;
    await doc.save();

    if (doc.status === 'exhausted') {
      await this.send(
        doc,
        'provider_exhausted',
        `${doc.provider}: provider confirmed exhausted`,
        `Provider: ${doc.provider}\nA confirmed billing/quota-exceeded response was received from a real API call, or an admin marked this provider exhausted directly.\nRouting will skip this provider until it recovers.`,
      );
    } else if (previous === 'exhausted') {
      await this.send(doc, 'provider_recovered', `${doc.provider}: provider recovered`, `Provider: ${doc.provider}\nStatus moved from exhausted to ${doc.status}. Routing will resume using it normally.`);
    }
  }

  // ---- 3/4/5: budget pace tiers ---------------------------------------------

  private async checkBudgetPace(doc: ProviderAccountDocument): Promise<void> {
    if (!doc.monthlyBudget) return; // nothing to compare against — never guesses a tier.
    const view = await this.finance.getAccount(doc.provider);
    const pct = view.budgetPacePct;
    if (pct == null) return;

    const crossedTier = [...BUDGET_TIERS].sort((a, b) => b - a).find((tier) => pct >= tier);

    if (crossedTier != null && (doc.lastAlertedBudgetPct == null || crossedTier > doc.lastAlertedBudgetPct)) {
      doc.lastAlertedBudgetPct = crossedTier;
      await doc.save();
      const label = crossedTier >= 100 ? 'over budget' : `${crossedTier}% of budget consumed`;
      await this.send(
        doc,
        'budget_pace',
        `${doc.provider}: ${label} this month`,
        `Provider: ${doc.provider}\nConsumption this month: ${doc.currency} ${view.consumptionThisMonth.toFixed(2)} of a ${doc.currency} ${doc.monthlyBudget.toFixed(2)} monthly budget (${pct.toFixed(0)}%).`,
      );
    } else if (crossedTier == null && doc.lastAlertedBudgetPct != null) {
      doc.lastAlertedBudgetPct = null;
      await doc.save();
      await this.send(
        doc,
        'budget_pace_recovered',
        `${doc.provider}: back under budget pace`,
        `Provider: ${doc.provider}\nConsumption this month (${doc.currency} ${view.consumptionThisMonth.toFixed(2)}) is back under the lowest alert tier of its ${doc.currency} ${doc.monthlyBudget.toFixed(2)} budget.`,
      );
    }
  }

  // ---- 6/7: usage-cost sync health -------------------------------------------

  private async checkUsageCostSyncHealth(doc: ProviderAccountDocument): Promise<void> {
    const adapter = this.adapters.get(doc.provider);
    if (!adapter) return;
    const capabilities = adapter.getCapabilities({ adminApiKeyEncrypted: doc.adminApiKeyEncrypted });
    if (capabilities[ProviderCapability.USAGE_COST_READ].status !== 'SUPPORTED') return; // CONFIGURATION_REQUIRED/PERMISSION_REQUIRED handled daily, not hourly — see sendDailySummary.

    const isStale = !doc.lastUsageCostSyncAt || Date.now() - doc.lastUsageCostSyncAt.getTime() > SYNC_STALE_HOURS * 3_600_000;
    const failing = !!doc.lastUsageCostSyncError || isStale;
    if (failing === doc.lastAlertedSyncFailing) return;
    doc.lastAlertedSyncFailing = failing;
    await doc.save();

    if (failing) {
      await this.send(
        doc,
        'usage_cost_sync_failed',
        `${doc.provider}: usage-cost sync failing`,
        `Provider: ${doc.provider}\n${doc.lastUsageCostSyncError ? `Last error: ${doc.lastUsageCostSyncError}` : `No successful sync in over ${SYNC_STALE_HOURS}h.`}`,
      );
    } else {
      await this.send(doc, 'usage_cost_sync_recovered', `${doc.provider}: usage-cost sync recovered`, `Provider: ${doc.provider}\nThe hourly usage-cost sync is succeeding again.`);
    }
  }

  // ---- 12: provider-reported cost vs Haive-tracked cost variance -----------

  private async checkCostVariance(doc: ProviderAccountDocument): Promise<void> {
    if (doc.lastProviderReportedCostThisMonth == null) return;
    const view = await this.finance.getAccount(doc.provider);
    if (view.usageCostSync.costVariancePct == null) return;
    if (Math.abs(view.usageCostSync.costVariancePct) < COST_VARIANCE_ALERT_PCT) return;

    await this.send(
      doc,
      'cost_variance',
      `${doc.provider}: provider-reported cost differs from Haive's tracked cost`,
      `Provider: ${doc.provider}\nProvider-reported cost this month: ${doc.currency} ${doc.lastProviderReportedCostThisMonth.toFixed(2)}\nHaive-tracked cost this month: ${doc.currency} ${view.consumptionThisMonth.toFixed(2)}\nVariance: ${view.usageCostSync.costVariancePct.toFixed(1)}%`,
    );
  }

  // ---- 11: spend-spike anomaly ----------------------------------------------

  private async checkSpendSpike(doc: ProviderAccountDocument): Promise<void> {
    const startOfToday = startOfDayIst();
    const sevenDaysAgo = new Date(startOfToday.getTime() - 7 * 86_400_000);

    const [todayCost, trailingWeekCost] = await Promise.all([
      this.hierarchy.getProviderCostSince(doc.provider, startOfToday),
      this.hierarchy.getProviderCostSince(doc.provider, sevenDaysAgo),
    ]);
    const trailingDailyAverage = (trailingWeekCost - todayCost) / 7;
    if (trailingDailyAverage <= 0.01 || todayCost < trailingDailyAverage * SPEND_SPIKE_MULTIPLIER) return;

    await this.send(
      doc,
      'spend_spike',
      `${doc.provider}: unusual spend spike today`,
      `Provider: ${doc.provider}\nToday's cost so far: ${doc.currency} ${todayCost.toFixed(2)}, more than ${SPEND_SPIKE_MULTIPLIER}x the trailing 7-day daily average of ${doc.currency} ${trailingDailyAverage.toFixed(2)}.`,
    );
  }

  // ---- 13: payment overdue heuristic ----------------------------------------

  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async checkOverduePayments(): Promise<void> {
    try {
      const dashboard = await this.finance.getFinanceDashboard(1);
      if (!dashboard.nextExpectedRechargeDateEstimate) return;
      if (dashboard.nextExpectedRechargeDateEstimate.getTime() > Date.now()) return;

      const lastPayment = await this.paymentModel.findOne().sort({ paymentDate: -1 }).exec();
      if (lastPayment && lastPayment.paymentDate.getTime() > dashboard.nextExpectedRechargeDateEstimate.getTime()) return; // a payment already arrived after the estimate.

      const admins = await this.adminModel.find({ active: true }, { email: 1 }).exec();
      const title = 'Provider recharge may be overdue';
      const message = `Based on past payment cadence, a new recharge was estimated around ${dashboard.nextExpectedRechargeDateEstimate.toISOString().slice(0, 10)}, but none has been recorded yet. This is an ESTIMATE, not a confirmed provider signal.`;
      await Promise.all(admins.map((a) => this.mail.sendNotificationEmail(a.email, title, message)));
      await this.alertLogModel.create({ provider: 'platform', alertType: 'payment_overdue', title, message });
    } catch (err) {
      this.logger.error(`Overdue-payment check failed: ${(err as Error).message}`);
    }
  }

  // ---- 9: new payment recorded -----------------------------------------------

  async notifyPaymentRecorded(provider: string, amount: number, currency: string): Promise<void> {
    const doc = await this.accountModel.findOne({ provider }).exec();
    if (!doc) return;
    await this.send(doc, 'payment_recorded', `${provider}: payment recorded`, `Provider: ${provider}\nAmount: ${currency} ${amount.toFixed(2)}`);
  }

  // ---- 10: daily spending summary, + 8: configuration-needed ----------------

  // Reuses getFinanceDashboard() directly rather than a second aggregation,
  // so this email can never disagree with what the dashboard itself shows.
  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async sendDailySummary(): Promise<void> {
    try {
      const dashboard = await this.finance.getFinanceDashboard(1);
      const admins = await this.adminModel.find({ active: true }, { email: 1 }).exec();
      const title = `Daily AI provider spend: $${dashboard.totalConsumptionThisMonth.toFixed(2)} this month so far`;
      const description = [
        `Payments in range: $${dashboard.totalPaymentsInRange.toFixed(2)}`,
        `Active providers: ${dashboard.activeProviderCount}, near/over budget: ${dashboard.nearOrOverBudgetProviderCount}, exhausted: ${dashboard.exhaustedProviderCount}, needing configuration: ${dashboard.needsConfigurationProviderCount}`,
        ...dashboard.accounts.map((a) => `${a.provider}: ${a.currency} ${a.consumptionThisMonth.toFixed(2)} this month${a.monthlyBudget ? ` of a ${a.currency} ${a.monthlyBudget.toFixed(2)} budget` : ''} — balance: ${a.balance.note}`),
      ].join('\n');
      await Promise.all(admins.map((admin) => this.mail.sendNotificationEmail(admin.email, title, description)));
      await this.alertLogModel.create({ provider: 'platform', alertType: 'daily_summary', title, message: description });

      for (const account of dashboard.accounts) {
        const needsConfig = Object.values(account.capabilities ?? {}).find((c) => c.status === 'CONFIGURATION_REQUIRED' || c.status === 'PERMISSION_REQUIRED');
        if (!needsConfig) continue;
        const doc = await this.accountModel.findOne({ provider: account.provider }).exec();
        if (!doc) continue;
        await this.send(doc, 'capability_needs_configuration', `${account.provider}: some finance capabilities need configuration`, `Provider: ${account.provider}\n${needsConfig.detail}`);
      }
    } catch (err) {
      this.logger.error(`Daily provider-spend summary failed: ${(err as Error).message}`);
    }
  }
}
