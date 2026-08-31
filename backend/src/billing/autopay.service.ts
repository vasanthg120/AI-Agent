import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EncryptionService } from '../common/encryption/encryption.service';
import { PAYMENT_PROVIDER, PaymentProviderAdapter } from './providers/payment-provider.interface';
import { BillingInvoiceService } from './billing-invoice.service';
import { PricingService } from './pricing.service';
import { WalletService } from './wallet.service';
import { PaymentMethod, PaymentMethodDocument } from './schemas/payment-method.schema';
import { PaymentRecord, PaymentRecordDocument } from './schemas/payment-record.schema';
import { Wallet, WalletDocument } from './schemas/wallet.schema';

// A concurrent claim on the same wallet older than this is treated as
// abandoned (e.g. the process crashed mid-charge) rather than a permanent
// lock — see attemptRecharge's claim/release below.
const RECHARGE_LOCK_STALE_MS = 60_000;

export interface AutoPaySettingsUpdate {
  enabled: boolean;
  thresholdCredits?: number;
  rechargeAmountCredits?: number;
  paymentMethodId?: string;
  monthlyCapCredits?: number;
}

/**
 * "Auto Recharge" (customer-facing name, matching OpenAI's API billing
 * terminology) — a Haive Credits setting only, with no notion of which LLM
 * provider a request ends up using. Triggered synchronously from
 * ReservationService.reserve() when balance is insufficient.
 *
 * The charge amount is dynamic, not a customer-chosen flat number: it's
 * whatever the caller says is actually needed (attemptRecharge's
 * `requiredCredits`), floored at the admin-configured
 * BillingSettings.autoRechargeMinCredits and capped at
 * autoRechargeMaxCredits — see attemptRecharge's own doc comment. Converted
 * to a real charge amount via PricingService's credits<->currency bridge,
 * same as every other credit-to-money conversion in this module.
 */
@Injectable()
export class AutoPayService {
  private readonly logger = new Logger(AutoPayService.name);

  constructor(
    @InjectModel(Wallet.name) private walletModel: Model<WalletDocument>,
    @InjectModel(PaymentMethod.name) private paymentMethodModel: Model<PaymentMethodDocument>,
    @InjectModel(PaymentRecord.name) private paymentRecordModel: Model<PaymentRecordDocument>,
    @Inject(PAYMENT_PROVIDER) private paymentProvider: PaymentProviderAdapter,
    private walletService: WalletService,
    private pricing: PricingService,
    private encryption: EncryptionService,
    private config: ConfigService,
    // Sibling provider in BillingModule (no other service dependencies of
    // its own) — reused here only for its existing getOrCreateSettings()
    // singleton read, the same one billing-admin-settings.service.ts and
    // BillingInvoiceService.generateForPaymentRecord already share.
    private invoices: BillingInvoiceService,
  ) {}

  async updateSettings(organizationId: string, update: AutoPaySettingsUpdate): Promise<WalletDocument> {
    const wallet = await this.walletService.getOrCreateWallet(organizationId);

    if (update.enabled) {
      const rechargeAmount = update.rechargeAmountCredits ?? wallet.autoPay.rechargeAmountCredits;
      if (!(rechargeAmount > 0)) {
        throw new BadRequestException('The recharge amount must be greater than zero.');
      }
      const paymentMethodId = update.paymentMethodId ?? wallet.autoPay.paymentMethodId;
      if (!paymentMethodId) {
        throw new BadRequestException('A saved payment method is required to enable Auto Recharge.');
      }
      const method = await this.paymentMethodModel.findOne({ _id: paymentMethodId, organizationId });
      if (!method) throw new BadRequestException('That payment method is not on file for this organization.');
    }

    wallet.autoPay.enabled = update.enabled;
    if (update.thresholdCredits !== undefined) wallet.autoPay.thresholdCredits = update.thresholdCredits;
    if (update.rechargeAmountCredits !== undefined) wallet.autoPay.rechargeAmountCredits = update.rechargeAmountCredits;
    if (update.paymentMethodId !== undefined) wallet.autoPay.paymentMethodId = update.paymentMethodId;
    if (update.monthlyCapCredits !== undefined) wallet.autoPay.monthlyCapCredits = update.monthlyCapCredits;
    if (!update.enabled) {
      wallet.autoPay.consecutiveFailures = 0;
    }
    // Required — a wallet whose autoPay subdocument was created via the
    // upsert path in WalletService.getOrCreateWallet doesn't reliably carry
    // Mongoose's automatic dirty-tracking for in-place mutations of a
    // single-nested subdocument's own fields; without this, wallet.save()
    // silently persists nothing for this path (caught live: the response
    // reflected enabled:true but a fresh read showed enabled:false).
    wallet.markModified('autoPay');
    await wallet.save();
    return wallet;
  }

  /** Charges the org's saved payment method for the actual amount needed
   * (the caller's `requiredCredits` — e.g. ReservationService's reservation
   * shortfall), floored at the admin-configured
   * BillingSettings.autoRechargeMinCredits and capped at
   * autoRechargeMaxCredits when set — never a customer-chosen flat amount,
   * and never the full price of whatever plan the org originally bought.
   * Falls back to `wallet.autoPay.rechargeAmountCredits` as the floor only
   * if an admin has never configured a minimum, so an existing deployment's
   * behavior doesn't change out from under it. Credits the wallet only on a
   * provider-confirmed successful charge. Returns false (never throws) on
   * any failure — the caller (ReservationService) treats a false return as
   * "Auto Recharge did not help," not as a hard error.
   *
   * Concurrency: an atomic claim on Wallet.autoPay.rechargeLockedAt (same
   * atomic-findOneAndUpdate idiom as WalletService.tryReserve) ensures two
   * requests racing on the same empty wallet can only ever produce one
   * charge — the loser sees the claim fail and returns false immediately,
   * exactly like a failed reservation. */
  async attemptRecharge(organizationId: string, reason: string, requiredCredits?: number): Promise<boolean> {
    const wallet = await this.walletService.getOrCreateWallet(organizationId);
    if (!wallet.autoPay?.enabled || !wallet.autoPay.paymentMethodId) {
      return false;
    }

    const maxFailures = this.config.get<number>('billing.autoPayMaxConsecutiveFailures') ?? 3;
    if (wallet.autoPay.consecutiveFailures >= maxFailures) {
      this.logger.warn(`Auto Recharge for org ${organizationId} skipped — ${wallet.autoPay.consecutiveFailures} consecutive failures already recorded.`);
      return false;
    }

    const lockTimestamp = new Date();
    const claimed = await this.walletModel
      .findOneAndUpdate(
        {
          _id: wallet._id,
          $or: [
            { 'autoPay.rechargeLockedAt': { $exists: false } },
            { 'autoPay.rechargeLockedAt': { $lt: new Date(Date.now() - RECHARGE_LOCK_STALE_MS) } },
          ],
        },
        { $set: { 'autoPay.rechargeLockedAt': lockTimestamp } },
      )
      .exec();
    if (!claimed) {
      this.logger.warn(`Auto Recharge for org ${organizationId} skipped — another recharge is already in flight for this wallet.`);
      return false;
    }
    // Mirrored onto the in-memory document too: every branch below calls
    // wallet.save() with autoPay marked modified, which serializes the
    // whole subdocument — without this, that save would silently overwrite
    // the lock we just claimed back to unset, defeating it before the
    // finally block below ever runs.
    wallet.autoPay.rechargeLockedAt = lockTimestamp;

    try {
      const settings = await this.invoices.getOrCreateSettings();
      const adminMin = settings.autoRechargeMinCredits ?? wallet.autoPay.rechargeAmountCredits ?? 0;
      let creditsNeeded = Math.max(requiredCredits ?? adminMin, adminMin);
      if (settings.autoRechargeMaxCredits) {
        creditsNeeded = Math.min(creditsNeeded, settings.autoRechargeMaxCredits);
      }
      if (!(creditsNeeded > 0)) {
        return false;
      }

      if (wallet.autoPay.monthlyCapCredits) {
        const alreadyRecharged = await this.walletService.sumAutoRechargeThisMonth(organizationId);
        if (alreadyRecharged + creditsNeeded > wallet.autoPay.monthlyCapCredits) {
          this.logger.warn(
            `Auto Recharge for org ${organizationId} skipped — monthly cap of ${wallet.autoPay.monthlyCapCredits} credits would be exceeded (already recharged ${alreadyRecharged} this month, would need ${creditsNeeded} more).`,
          );
          return false;
        }
      }

      const method = await this.paymentMethodModel.findOne({ _id: wallet.autoPay.paymentMethodId, organizationId });
      if (!method) {
        this.logger.warn(`Auto Recharge for org ${organizationId} misconfigured (payment method missing) — disabling.`);
        wallet.autoPay.enabled = false;
        wallet.markModified('autoPay');
        await wallet.save();
        return false;
      }

      // Auto Recharge must always charge through the payment method's OWN
      // saved gateway, not whichever provider happens to be active right now
      // — a deployment could switch ACTIVE_PAYMENT_PROVIDER after a customer
      // already saved a Razorpay card, and this method's saved token would
      // be meaningless to Stripe/Cashfree.
      if (method.provider !== this.paymentProvider.providerKey) {
        this.logger.warn(
          `Auto Recharge for org ${organizationId} skipped — saved payment method belongs to "${method.provider}" but the active gateway is "${this.paymentProvider.providerKey}".`,
        );
        return false;
      }

      const amountUsd = this.pricing.creditsToUsd(creditsNeeded);
      const amount = this.pricing.usdToCurrency(amountUsd);
      const currency = this.pricing.billingCurrency;

      const record = await this.paymentRecordModel.create({
        organizationId,
        walletId: wallet._id.toString(),
        type: 'autopay',
        provider: this.paymentProvider.providerKey,
        gatewayOrderId: `autorecharge_${wallet._id.toString()}_${Date.now()}`,
        amount,
        currency,
        creditsGranted: creditsNeeded,
        status: 'created',
      });

      const charge = await this.paymentProvider.chargeSavedMethod(
        organizationId,
        method.gatewayCustomerId,
        this.encryption.decrypt(method.gatewayTokenIdEncrypted),
        amount,
        currency,
      );

      if (!charge.success) {
        record.status = 'failed';
        await record.save();
        wallet.autoPay.consecutiveFailures += 1;
        wallet.autoPay.lastTriggeredAt = new Date();
        if (wallet.autoPay.consecutiveFailures >= maxFailures) {
          wallet.autoPay.enabled = false;
          this.logger.warn(`Auto Recharge for org ${organizationId} auto-disabled after ${maxFailures} consecutive failures.`);
        }
        wallet.markModified('autoPay');
        await wallet.save();
        return false;
      }

      record.status = 'captured';
      record.gatewayPaymentId = charge.paymentId;
      record.simulated = charge.simulated;
      await record.save();

      await this.walletService.applyLedgerEntry(organizationId, 'AUTO_RECHARGE', creditsNeeded, {
        paymentRecordId: record._id.toString(),
        metadata: {
          reason,
          creditsCharged: creditsNeeded,
          requiredCredits: requiredCredits ?? null,
          adminMinCredits: adminMin,
          provider: this.paymentProvider.providerKey,
          simulated: charge.simulated,
          gatewayPaymentId: charge.paymentId,
        },
        createdBy: 'autopay',
      });

      wallet.autoPay.consecutiveFailures = 0;
      wallet.autoPay.lastTriggeredAt = new Date();
      wallet.markModified('autoPay');
      await wallet.save();
      return true;
    } finally {
      await this.walletModel.updateOne({ _id: wallet._id }, { $unset: { 'autoPay.rechargeLockedAt': '' } }).exec();
    }
  }
}
