import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Wallet, WalletDocument } from './schemas/wallet.schema';
import {
  WalletTransaction,
  WalletTransactionDocument,
  WalletTransactionType,
} from './schemas/wallet-transaction.schema';

export interface WalletSummary {
  balanceCredits: number;
  reservedCredits: number;
  availableCredits: number;
  lowBalanceThresholdCredits: number;
  lowBalance: boolean;
  autoPay: Wallet['autoPay'];
}

export interface LedgerOpts {
  reservationId?: string;
  paymentRecordId?: string;
  metadata?: Record<string, unknown>;
  createdBy: string;
}

/**
 * Owns Wallet.balanceCredits/reservedCredits (both maintained exclusively
 * via atomic Mongo operations — never read-modify-write) and the immutable
 * WalletTransaction ledger. This is the ONLY place either collection is
 * written; ReservationService/AutoPayService/BillingService all go through
 * these methods rather than touching the models directly.
 */
@Injectable()
export class WalletService {
  constructor(
    @InjectModel(Wallet.name) private walletModel: Model<WalletDocument>,
    @InjectModel(WalletTransaction.name) private transactionModel: Model<WalletTransactionDocument>,
    private config: ConfigService,
  ) {}

  /** Creates the wallet on first touch (lazy, not at organization-creation
   * time — the org-creation flow is shared across password/OAuth signup and
   * doesn't need to know about billing) and, exactly on that first creation,
   * grants config.billing.freeTrialCredits with an auditable FREE_TRIAL
   * ledger row.
   *
   * Idempotency for the trial grant reuses the SAME atomic upsert that
   * already makes wallet creation itself race-safe (organizationId is
   * uniquely indexed) — `rawResult: true` surfaces whether this particular
   * call is the one that actually inserted the document
   * (`lastErrorObject.upserted`) or lost the race to a concurrent caller
   * and just matched the now-existing one. Only the winner writes the
   * ledger row, so retries/races can never grant the trial twice. */
  async getOrCreateWallet(organizationId: string): Promise<WalletDocument> {
    const existing = await this.walletModel.findOne({ organizationId });
    if (existing) return existing;

    const freeTrialCredits = this.config.get<number>('billing.freeTrialCredits') ?? 20;
    const autoRechargeDefault = this.config.get<boolean>('billing.autoRechargeDefault') ?? false;

    // Concurrent first-ever calls for the same org could both miss the find
    // above — upsert makes wallet creation itself race-safe, same idiom as
    // IntegrationsService.connect's findOneAndUpdate({upsert:true}).
    // autoPay's defaults are spelled out explicitly here rather than relied
    // on from the schema — verified via live testing that even with
    // setDefaultsOnInsert:true, Mongoose's findOneAndUpdate upsert path
    // does NOT reliably hydrate a single-nested subdocument's own field
    // defaults (it stored a bare `{}` for autoPay instead of
    // {enabled:false, thresholdCredits:200, consecutiveFailures:0, ...}) —
    // that hydration only reliably happens via `new Model().save()`, not a
    // query-based upsert.
    const result = (await this.walletModel.findOneAndUpdate(
      { organizationId },
      {
        $setOnInsert: {
          organizationId,
          balanceCredits: freeTrialCredits,
          reservedCredits: 0,
          autoPay: {
            enabled: autoRechargeDefault,
            thresholdCredits: 200,
            rechargeAmountCredits: 2000,
            consecutiveFailures: 0,
          },
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, includeResultMetadata: true },
    )) as unknown as { value: WalletDocument; lastErrorObject?: { upserted?: unknown } };

    const wallet = result.value;
    if (result.lastErrorObject?.upserted && freeTrialCredits > 0) {
      await this.transactionModel.create({
        organizationId,
        walletId: wallet._id.toString(),
        type: 'FREE_TRIAL',
        amountCredits: freeTrialCredits,
        balanceAfterCredits: freeTrialCredits,
        metadata: { reason: 'organization_signup' },
        createdBy: 'system',
      });
    }
    return wallet;
  }

  async getSummary(organizationId: string, defaultLowBalanceThreshold: number): Promise<WalletSummary> {
    const wallet = await this.getOrCreateWallet(organizationId);
    const threshold = wallet.lowBalanceThresholdCredits ?? defaultLowBalanceThreshold;
    const available = wallet.balanceCredits - wallet.reservedCredits;
    return {
      balanceCredits: wallet.balanceCredits,
      reservedCredits: wallet.reservedCredits,
      availableCredits: available,
      lowBalanceThresholdCredits: threshold,
      lowBalance: available <= threshold,
      autoPay: wallet.autoPay,
    };
  }

  /** Atomic reserve — the filter itself is the check (see
   * organizations.service.ts's claimMorningRun for the same idiom). Only
   * succeeds if `balanceCredits - reservedCredits >= amountCredits` at the
   * moment the write executes; two concurrent callers can never both
   * succeed past the point where doing so would overspend the wallet. */
  /** What the wallet can still spend: its balance less what running requests hold. */
  async availableCredits(walletId: string): Promise<number> {
    const wallet = await this.walletModel.findById(walletId).select('balanceCredits reservedCredits').lean().exec();
    return wallet ? wallet.balanceCredits - wallet.reservedCredits : 0;
  }

  async tryReserve(walletId: string, amountCredits: number): Promise<boolean> {
    const result = await this.walletModel.updateOne(
      {
        _id: walletId,
        $expr: { $gte: [{ $subtract: ['$balanceCredits', '$reservedCredits'] }, amountCredits] },
      },
      { $inc: { reservedCredits: amountCredits } },
    );
    return result.modifiedCount > 0;
  }

  /** Releases a reservation's held amount back without touching balance —
   * used both for explicit release (LLM call failed) and as half of settle. */
  async releaseReservedAmount(walletId: string, amountCredits: number): Promise<void> {
    await this.walletModel.updateOne({ _id: walletId }, { $inc: { reservedCredits: -amountCredits } });
  }

  /** Settlement's atomic step: releases the held reservation amount AND
   * debits the wallet by the actual charge, in one update. Deliberately
   * unguarded (no $expr floor) — the LLM calls already happened and can't
   * be unspent; if actual usage exceeds what was reserved, balanceCredits
   * is allowed to go negative as a post-hoc true-up. The *next* reserve
   * call naturally fails closed since availableCredits is already low. */
  async settleUsage(walletId: string, reservedAmountCredits: number, actualCreditsCharged: number): Promise<WalletDocument> {
    const updated = await this.walletModel.findOneAndUpdate(
      { _id: walletId },
      { $inc: { reservedCredits: -reservedAmountCredits, balanceCredits: -actualCreditsCharged } },
      { new: true },
    );
    if (!updated) throw new Error(`Wallet ${walletId} not found during settlement`);
    return updated;
  }

  /** Generic ledger-affecting credit/debit for every non-reservation
   * transaction type (PURCHASE/AUTO_RECHARGE/BONUS/PROMOTION/REFUND/
   * MANUAL_ADJUSTMENT) — amountCredits is signed (positive grants,
   * negative debits, e.g. a MANUAL_ADJUSTMENT correction). */
  async applyLedgerEntry(
    organizationId: string,
    type: Exclude<WalletTransactionType, 'AI_USAGE'>,
    amountCredits: number,
    opts: LedgerOpts,
  ): Promise<WalletDocument> {
    const wallet = await this.getOrCreateWallet(organizationId);
    const updated = await this.walletModel.findOneAndUpdate(
      { _id: wallet._id },
      { $inc: { balanceCredits: amountCredits } },
      { new: true },
    );
    if (!updated) throw new Error(`Wallet for org ${organizationId} not found`);
    await this.transactionModel.create({
      organizationId,
      walletId: updated._id.toString(),
      type,
      amountCredits,
      balanceAfterCredits: updated.balanceCredits,
      reservationId: opts.reservationId,
      paymentRecordId: opts.paymentRecordId,
      metadata: opts.metadata ?? {},
      createdBy: opts.createdBy,
    });
    return updated;
  }

  /** Writes the AI_USAGE ledger row after settleUsage has already applied
   * the atomic balance change — kept as a separate step (not fused into
   * settleUsage) since ReservationService needs the freshly-settled
   * wallet's balanceCredits for the row's balanceAfterCredits snapshot. */
  async recordUsageTransaction(
    wallet: WalletDocument,
    reservationId: string,
    creditsCharged: number,
    metadata: Record<string, unknown>,
    createdBy: string,
  ): Promise<void> {
    await this.transactionModel.create({
      organizationId: wallet.organizationId,
      walletId: wallet._id.toString(),
      type: 'AI_USAGE',
      amountCredits: -creditsCharged,
      balanceAfterCredits: wallet.balanceCredits,
      reservationId,
      metadata,
      createdBy,
    });
  }

  listTransactions(organizationId: string, limit = 50) {
    return this.transactionModel.find({ organizationId }).sort({ createdAt: -1 }).limit(limit).exec();
  }

  /** Sums AUTO_RECHARGE credits already granted this calendar month — the
   * "check monthly limit" step AutoPayService.attemptRecharge runs before
   * charging a saved card, so a runaway sequence of small reserve()
   * failures can't recharge the wallet indefinitely in one billing month. */
  async sumAutoRechargeThisMonth(organizationId: string): Promise<number> {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const rows = await this.transactionModel
      .aggregate<{ credits: number }>([
        { $match: { organizationId, type: 'AUTO_RECHARGE', createdAt: { $gte: startOfMonth } } },
        { $group: { _id: null, credits: { $sum: '$amountCredits' } } },
      ])
      .exec();
    return rows[0]?.credits ?? 0;
  }
}
