import { Cron, CronExpression } from '@nestjs/schedule';
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AgentExecution, AgentExecutionDocument } from '../command-center/schemas/agent-execution.schema';
import { AutoPayService } from './autopay.service';
import { PricingService } from './pricing.service';
import { WalletService } from './wallet.service';
import { CreditReservation, CreditReservationDocument } from './schemas/credit-reservation.schema';
import { ProviderPricing, ProviderPricingDocument } from './schemas/provider-pricing.schema';

export interface ReserveResult {
  reservationId: string;
  estimatedCredits: number;
  availableCredits: number;
}

export interface SettleResult {
  creditsCharged: number;
  balanceCredits: number;
  lowBalanceWarning: boolean;
}

interface UsageGroup {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Orchestrates the reserve -> settle/release lifecycle around one chat
 * turn. Called by python-agent (via the service-JWT bridge) from
 * routes/chat.py, once before run_agent() and once after — never from
 * inside the LLM call loop itself.
 */
@Injectable()
export class ReservationService {
  private readonly logger = new Logger(ReservationService.name);

  constructor(
    @InjectModel(CreditReservation.name) private reservationModel: Model<CreditReservationDocument>,
    @InjectModel(ProviderPricing.name) private pricingModel: Model<ProviderPricingDocument>,
    @InjectModel(AgentExecution.name) private executionModel: Model<AgentExecutionDocument>,
    private wallet: WalletService,
    private pricing: PricingService,
    private autoPay: AutoPayService,
    private config: ConfigService,
  ) {}

  async reserve(organizationId: string, userId: string, requestId: string, conversationId: string): Promise<ReserveResult> {
    const existing = await this.reservationModel.findOne({ requestId });
    if (existing) {
      // Idempotent retry (e.g. a lost response): don't double-reserve.
      const summary = await this.wallet.getSummary(organizationId, this.defaultThreshold());
      return { reservationId: existing._id.toString(), estimatedCredits: existing.estimatedCredits, availableCredits: summary.availableCredits };
    }

    const ceiling = this.config.get<number>('billing.reservationCeilingCredits') ?? 500;
    const walletDoc = await this.wallet.getOrCreateWallet(organizationId);
    const walletId = walletDoc._id.toString();

    let ok = await this.wallet.tryReserve(walletId, ceiling);

    if (!ok && walletDoc.autoPay?.enabled) {
      // "Required" = the actual shortfall against the reservation ceiling,
      // not a customer-chosen flat amount and never the full price of
      // whatever plan the org originally bought — AutoPayService floors
      // this at the admin-configured minimum and caps it at the maximum.
      // Provider cost for this turn isn't known yet at this point (that's
      // only ever computed later, at settle()) — the ceiling shortfall is
      // the correct forward-looking equivalent for "how much do we need to
      // proceed" in this reserve-before-cost-is-known architecture.
      const available = walletDoc.balanceCredits - walletDoc.reservedCredits;
      const shortfall = Math.max(ceiling - available, 0);
      const recharged = await this.autoPay.attemptRecharge(organizationId, 'insufficient_balance', shortfall);
      if (recharged) {
        ok = await this.wallet.tryReserve(walletId, ceiling);
      }
    }

    if (!ok) {
      const summary = await this.wallet.getSummary(organizationId, this.defaultThreshold());
      throw new HttpException(
        {
          code: 'INSUFFICIENT_BALANCE',
          message: 'Your Haive Credits are exhausted. Add credits or enable Auto Recharge to continue using Haive AI.',
          availableCredits: summary.availableCredits,
          requiredCredits: ceiling,
          autoPayEnabled: walletDoc.autoPay?.enabled ?? false,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    const timeoutMinutes = this.config.get<number>('billing.reservationTimeoutMinutes') ?? 10;
    const reservation = await this.reservationModel.create({
      organizationId,
      walletId,
      requestId,
      conversationId,
      userId,
      estimatedCredits: ceiling,
      status: 'pending',
      expiresAt: new Date(Date.now() + timeoutMinutes * 60_000),
    });

    const postReserveSummary = await this.wallet.getSummary(organizationId, this.defaultThreshold());
    return { reservationId: reservation._id.toString(), estimatedCredits: ceiling, availableCredits: postReserveSummary.availableCredits };
  }

  async settle(requestId: string): Promise<SettleResult> {
    const reservation = await this.reservationModel.findOne({ requestId });
    if (!reservation) {
      throw new HttpException(`No reservation found for requestId ${requestId}`, HttpStatus.NOT_FOUND);
    }

    if (reservation.status === 'settled') {
      // Idempotent retry — return the already-settled outcome, never charge twice.
      const summary = await this.wallet.getSummary(reservation.organizationId, this.defaultThreshold());
      return { creditsCharged: reservation.settledCredits ?? 0, balanceCredits: summary.balanceCredits, lowBalanceWarning: summary.lowBalance };
    }
    if (reservation.status === 'released') {
      this.logger.warn(`settle() called for already-released reservation ${requestId} — treating as a zero-charge no-op`);
      const summary = await this.wallet.getSummary(reservation.organizationId, this.defaultThreshold());
      return { creditsCharged: 0, balanceCredits: summary.balanceCredits, lowBalanceWarning: summary.lowBalance };
    }

    const groups = await this.summarizeUsage(requestId);
    const totalCostUsd = groups.reduce((sum, g) => sum + g.costUsd, 0);
    const creditsCharged = this.pricing.providerCostToCustomerCredits(totalCostUsd);

    const walletDoc = await this.wallet.settleUsage(reservation.walletId, reservation.estimatedCredits, creditsCharged);

    await this.wallet.recordUsageTransaction(walletDoc, requestId, creditsCharged, {
      requestId,
      providerCostUsd: totalCostUsd,
      marginPct: this.config.get<number>('billing.targetGrossMargin') ?? 0.5,
      executionCount: groups.length,
      // Provider-identifying (admin-only): raw provider/model names.
      byProvider: groups.map((g) => ({ provider: g.provider, model: g.model, inputTokens: g.inputTokens, outputTokens: g.outputTokens })),
      // Non-identifying token totals — these ARE customer-facing ("Haive
      // Input/Output/Total Tokens"), unlike everything else in this
      // metadata object. billing.service.ts's listCustomerTransactions
      // reads exactly these two fields and nothing else from here.
      totalInputTokens: groups.reduce((sum, g) => sum + g.inputTokens, 0),
      totalOutputTokens: groups.reduce((sum, g) => sum + g.outputTokens, 0),
    }, reservation.userId);

    reservation.status = 'settled';
    reservation.settledCredits = creditsCharged;
    reservation.settledAt = new Date();
    await reservation.save();

    const threshold = walletDoc.lowBalanceThresholdCredits ?? this.defaultThreshold();
    const available = walletDoc.balanceCredits - walletDoc.reservedCredits;
    return { creditsCharged, balanceCredits: walletDoc.balanceCredits, lowBalanceWarning: available <= threshold };
  }

  async release(requestId: string): Promise<{ released: boolean }> {
    const reservation = await this.reservationModel.findOne({ requestId });
    if (!reservation) return { released: false };
    if (reservation.status !== 'pending') return { released: false };

    await this.wallet.releaseReservedAmount(reservation.walletId, reservation.estimatedCredits);
    reservation.status = 'released';
    reservation.releasedAt = new Date();
    await reservation.save();
    return { released: true };
  }

  /** Sums this turn's agent_executions rows by (provider, model), pricing
   * each group via the versioned ProviderPricing registry and falling back
   * to python-agent's own already-computed costUsd when no pricing row
   * matches — settlement never hard-fails on missing pricing config. */
  private async summarizeUsage(requestId: string): Promise<UsageGroup[]> {
    const rows = await this.executionModel
      .aggregate<{ _id: { provider: string; model: string }; inputTokens: number; outputTokens: number; costUsd: number }>([
        { $match: { requestId, kind: 'llm' } },
        {
          $group: {
            _id: { provider: '$provider', model: '$model' },
            inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
            outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
            costUsd: { $sum: { $ifNull: ['$costUsd', 0] } },
          },
        },
      ])
      .exec();

    const groups: UsageGroup[] = [];
    for (const row of rows) {
      const provider = row._id.provider ?? 'unknown';
      const model = row._id.model ?? '*';
      const pricingRow = await this.resolvePricing(provider, model);
      const costUsd = pricingRow
        ? (row.inputTokens / 1_000_000) * pricingRow.inputCostPerMTokUsd + (row.outputTokens / 1_000_000) * pricingRow.outputCostPerMTokUsd
        : row.costUsd; // fallback: python-agent's own cost.py-derived estimate
      groups.push({ provider, model, inputTokens: row.inputTokens, outputTokens: row.outputTokens, costUsd });
    }
    return groups;
  }

  private async resolvePricing(provider: string, model: string): Promise<ProviderPricingDocument | null> {
    const now = new Date();
    const baseMatch = { provider, effectiveFrom: { $lte: now }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: now } }] };
    // Prefer an exact model match, fall back to the provider's '*' default.
    const exact = await this.pricingModel.findOne({ ...baseMatch, model }).sort({ effectiveFrom: -1 }).exec();
    if (exact) return exact;
    return this.pricingModel.findOne({ ...baseMatch, model: '*' }).sort({ effectiveFrom: -1 }).exec();
  }

  private defaultThreshold(): number {
    return this.config.get<number>('billing.lowBalanceThresholdCredits') ?? 200;
  }

  /** Crash safety net: if python-agent dies mid-turn without ever calling
   * settle or release, this reclaims the held reservedCredits instead of
   * leaving them stuck forever. */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweepExpiredReservations(): Promise<void> {
    const expired = await this.reservationModel.find({ status: 'pending', expiresAt: { $lt: new Date() } }).limit(500).exec();
    for (const reservation of expired) {
      await this.wallet.releaseReservedAmount(reservation.walletId, reservation.estimatedCredits);
      reservation.status = 'released';
      reservation.releasedAt = new Date();
      await reservation.save();
      this.logger.warn(`Swept expired reservation ${reservation.requestId} (org ${reservation.organizationId})`);
    }
  }
}
