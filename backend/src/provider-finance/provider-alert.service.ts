import { Cron, CronExpression } from '@nestjs/schedule';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AdminAccount, AdminAccountDocument } from '../auth/schemas/admin-account.schema';
import { MailService } from '../mail/mail.service';
import { FINANCE_TRACKED_PROVIDERS, ProviderFinanceService } from './provider-finance.service';
import { ProviderAccount, ProviderAccountDocument } from './schemas/provider-account.schema';

type AlertTierKind = 'informational' | 'low' | 'critical' | 'exhausted';

interface AlertTier {
  value: number;
  kind: AlertTierKind;
}

/** The worst (lowest-value) tier `pct` has fallen to or below, among 50%
 * (fixed, informational), the account's own low/critical thresholds, and 0%
 * (fixed, exhausted). Null means healthy — above every tier, no alert due. */
function currentTier(pct: number, account: Pick<ProviderAccountDocument, 'lowThresholdPct' | 'criticalThresholdPct'>): AlertTier | null {
  const unsorted: AlertTier[] = [
    { value: 50, kind: 'informational' },
    { value: account.lowThresholdPct, kind: 'low' },
    { value: account.criticalThresholdPct, kind: 'critical' },
    { value: 0, kind: 'exhausted' },
  ];
  const tiers = unsorted.sort((a, b) => b.value - a.value);
  let worst: AlertTier | null = null;
  for (const tier of tiers) {
    if (pct <= tier.value) worst = tier;
  }
  return worst;
}

// Cron-driven threshold alerting for LLM provider balances — same
// @Cron(CronExpression...) pattern billing/subscription-renewal.service.ts
// already uses. Reads ProviderFinanceService's own account view (never
// recomputes estimated balance independently) and tracks
// ProviderAccount.lastAlertedThresholdPct to dedup: only fires on a NEW,
// worse threshold crossing, and only sends a recovery notice once (reset to
// null by this service after sending it, same as recordReconciliation
// already resets it directly on a fresh reconciliation).
@Injectable()
export class ProviderAlertService {
  private readonly logger = new Logger(ProviderAlertService.name);

  constructor(
    @InjectModel(ProviderAccount.name) private accountModel: Model<ProviderAccountDocument>,
    @InjectModel(AdminAccount.name) private adminModel: Model<AdminAccountDocument>,
    private finance: ProviderFinanceService,
    private mail: MailService,
  ) {}

  private async resolveRecipients(account: ProviderAccountDocument): Promise<string[]> {
    if (account.alertRecipients?.length) return account.alertRecipients;
    const admins = await this.adminModel.find({ active: true }, { email: 1 }).exec();
    return admins.map((a) => a.email);
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
    // Nothing to compare against until an admin has reconciled at least
    // once — never guesses a tier from an absent balance.
    if (!doc || doc.confirmedBalance == null || !doc.lastReconciledAt) return;

    const view = await this.finance.getAccount(provider);
    if (view.estimatedBalance == null) return;
    const pct = (view.estimatedBalance / doc.confirmedBalance) * 100;
    const tier = currentTier(pct, doc);

    if (tier && (doc.lastAlertedThresholdPct == null || tier.value < doc.lastAlertedThresholdPct)) {
      await this.sendThresholdAlert(doc, view.estimatedBalance, pct, tier);
      doc.lastAlertedThresholdPct = tier.value;
      if (tier.kind === 'exhausted' && doc.zeroBalanceAction === 'mark-unavailable') doc.status = 'exhausted';
      await doc.save();
    } else if (!tier && doc.lastAlertedThresholdPct != null) {
      await this.sendRecoveryAlert(doc, view.estimatedBalance);
      doc.lastAlertedThresholdPct = null;
      if (doc.status === 'exhausted') doc.status = 'active';
      await doc.save();
    }
  }

  private async sendThresholdAlert(doc: ProviderAccountDocument, estimatedBalance: number, pct: number, tier: AlertTier): Promise<void> {
    const recipients = await this.resolveRecipients(doc);
    const title = `${doc.provider}: ${tier.kind} balance (${Math.round(pct)}% remaining)`;
    const recommended = doc.monthlyBudget ? `Recommended recharge: ${doc.currency} ${doc.monthlyBudget.toFixed(2)} (one month's budget).` : 'Recommended recharge: check recent consumption to size the next payment.';
    const description = [
      `Provider: ${doc.provider}`,
      `Estimated balance: ${doc.currency} ${estimatedBalance.toFixed(2)} (${Math.round(pct)}% of the last confirmed ${doc.currency} ${doc.confirmedBalance!.toFixed(2)}) — ESTIMATED, not provider-confirmed.`,
      `Last synchronized: ${doc.lastReconciledAt?.toISOString() ?? 'never'}`,
      recommended,
      tier.kind === 'exhausted'
        ? `Action required: this provider is treated as exhausted${doc.zeroBalanceAction === 'mark-unavailable' ? ' and marked unavailable for new requests' : ''} — recharge and reconcile as soon as possible.`
        : 'Action required: recharge soon and reconcile the new confirmed balance in Provider Finance.',
    ].join('\n');
    this.logger.warn(`Threshold alert for ${doc.provider}: ${tier.kind} (${Math.round(pct)}%)`);
    await Promise.all(recipients.map((email) => this.mail.sendNotificationEmail(email, title, description)));
  }

  private async sendRecoveryAlert(doc: ProviderAccountDocument, estimatedBalance: number): Promise<void> {
    const recipients = await this.resolveRecipients(doc);
    const title = `${doc.provider}: balance recovered`;
    const description = `Provider: ${doc.provider}\nEstimated balance is back above the informational threshold (${doc.currency} ${estimatedBalance.toFixed(2)}). No further action needed right now.`;
    this.logger.log(`Recovery alert for ${doc.provider}`);
    await Promise.all(recipients.map((email) => this.mail.sendNotificationEmail(email, title, description)));
  }

  // Daily spending summary — reuses getFinanceDashboard() directly rather
  // than a second aggregation, so this email can never disagree with what
  // the dashboard itself shows.
  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async sendDailySummary(): Promise<void> {
    try {
      const dashboard = await this.finance.getFinanceDashboard(1);
      const admins = await this.adminModel.find({ active: true }, { email: 1 }).exec();
      const title = `Daily AI provider spend: $${dashboard.totalConsumptionThisMonth.toFixed(2)} this month so far`;
      const description = [
        `Payments in range: $${dashboard.totalPaymentsInRange.toFixed(2)}`,
        `Active providers: ${dashboard.activeProviderCount}, low balance: ${dashboard.lowBalanceProviderCount}, exhausted: ${dashboard.exhaustedProviderCount}`,
        ...dashboard.accounts.map((a) => `${a.provider}: estimated ${a.estimatedBalance != null ? `${a.currency} ${a.estimatedBalance.toFixed(2)} (estimated)` : 'not yet reconciled'}`),
      ].join('\n');
      await Promise.all(admins.map((admin) => this.mail.sendNotificationEmail(admin.email, title, description)));
    } catch (err) {
      this.logger.error(`Daily provider-spend summary failed: ${(err as Error).message}`);
    }
  }
}
