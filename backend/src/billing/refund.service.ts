import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { WalletService } from './wallet.service';
import { CashfreePaymentProvider } from './providers/cashfree-payment.provider';
import { PaymentProviderAdapter, PaymentProviderKey } from './providers/payment-provider.interface';
import { RazorpayPaymentProvider } from './providers/razorpay-payment.provider';
import { StripePaymentProvider } from './providers/stripe-payment.provider';
import { BillingInvoice, BillingInvoiceDocument } from './schemas/billing-invoice.schema';
import { PaymentRecord, PaymentRecordDocument } from './schemas/payment-record.schema';
import { Refund, RefundDocument } from './schemas/refund.schema';

/**
 * Phase 6 — admin-only refunds. Mirrors billing-webhook.controller.ts's
 * per-provider adapter map: a refund must go through whichever gateway the
 * ORIGINAL payment captured through, not necessarily whichever is
 * config.billing.activePaymentProvider today (a deployment mid-migration
 * between gateways can still have old captured payments on the previous
 * one). Reuses the existing, currently-unused WalletTransaction 'REFUND'
 * type (see wallet-transaction.schema.ts) to claw back credits — no new
 * ledger machinery needed, same "layer on the existing wallet" philosophy
 * as subscriptions/coupons.
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);
  private readonly adapters: Record<PaymentProviderKey, PaymentProviderAdapter>;

  constructor(
    @InjectModel(PaymentRecord.name) private paymentRecordModel: Model<PaymentRecordDocument>,
    @InjectModel(Refund.name) private refundModel: Model<RefundDocument>,
    @InjectModel(BillingInvoice.name) private invoiceModel: Model<BillingInvoiceDocument>,
    razorpay: RazorpayPaymentProvider,
    stripe: StripePaymentProvider,
    cashfree: CashfreePaymentProvider,
    private wallet: WalletService,
  ) {
    this.adapters = { razorpay, stripe, cashfree };
  }

  listRefunds(filters: { organizationId?: string; paymentRecordId?: string; limit?: number }) {
    const query: Record<string, unknown> = {};
    if (filters.organizationId) query.organizationId = filters.organizationId;
    if (filters.paymentRecordId) query.paymentRecordId = filters.paymentRecordId;
    return this.refundModel
      .find(query)
      .sort({ createdAt: -1 })
      .limit(filters.limit ?? 100)
      .exec();
  }

  async refundPayment(paymentRecordId: string, actorUserId: string, opts: { amount?: number; reason?: string }): Promise<RefundDocument> {
    const record = await this.paymentRecordModel.findById(paymentRecordId).exec();
    if (!record) throw new NotFoundException('Payment record not found.');
    if (record.status !== 'captured' && record.status !== 'partially_refunded') {
      throw new BadRequestException(`Only captured payments can be refunded (current status: "${record.status}").`);
    }
    // gatewayPaymentId is deliberately NOT required here — a simulated
    // purchase (no gateway keys configured, the default until real ones are
    // added) never sets it: it's credited synchronously in
    // BillingService.initiatePurchase's simulated branch, which never goes
    // through confirmPurchase (the only path that populates this field).
    // Passing an empty string through is fine: the adapter's own
    // unconfigured/simulated branch ignores both ids entirely, and a real
    // (configured) adapter missing a payment id on an actually-captured
    // payment would be a genuine gateway-side error anyway, which surfaces
    // as a normal failed-refund result below rather than a hard block here.

    const alreadyRefunded = record.refundedAmount ?? 0;
    const refundableAmount = Math.round((record.amount - alreadyRefunded) * 100) / 100;
    const requestedAmount = opts.amount ?? refundableAmount;
    if (requestedAmount <= 0 || requestedAmount > refundableAmount + 0.005) {
      throw new BadRequestException(`Refund amount must be between 0 and ${refundableAmount} (${refundableAmount === record.amount ? 'full amount' : 'remaining after prior refunds'}).`);
    }

    const adapter = this.adapters[record.provider];
    const result = await adapter.refundPayment(record.gatewayOrderId, record.gatewayPaymentId ?? '', requestedAmount, opts.reason);

    const refundDoc = await this.refundModel.create({
      organizationId: record.organizationId,
      paymentRecordId: record._id.toString(),
      provider: record.provider,
      gatewayRefundId: result.gatewayRefundId,
      amount: requestedAmount,
      currency: record.currency,
      reason: opts.reason,
      status: result.success ? 'succeeded' : 'failed',
      simulated: result.simulated,
      createdBy: actorUserId,
    });

    if (!result.success) {
      this.logger.warn(`Refund attempt failed for payment ${paymentRecordId}: ${result.reason}`);
      return refundDoc;
    }

    const newRefundedAmount = Math.round((alreadyRefunded + requestedAmount) * 100) / 100;
    const isFullRefund = newRefundedAmount >= record.amount - 0.005;

    // Cumulative target, not a per-refund proportional share: computing
    // this refund's clawback as creditsGranted * (requestedAmount/amount)
    // in isolation double-counts whatever a PRIOR partial refund on the
    // same payment already clawed back. Instead: figure out the total
    // credits that SHOULD be gone once this refund lands (target), and
    // claw back only the delta versus refundedCreditsTotal so far — a full
    // refund always lands on exactly creditsGranted with zero rounding
    // leftover, and a second partial refund correctly gets only its own
    // remaining share. Caught live by refund.spec.ts's sequential-partial-
    // refunds test: a naive per-refund proportional calc clawed back 1000
    // credits on a refund that should only have clawed back 750 (1000 had
    // already been split into a 250 first refund + this 750 second one).
    const alreadyClawedBackCredits = record.refundedCreditsTotal ?? 0;
    const targetCumulativeCredits = isFullRefund
      ? record.creditsGranted
      : Math.round(record.creditsGranted * (newRefundedAmount / record.amount));
    const creditsToClawBack = targetCumulativeCredits - alreadyClawedBackCredits;

    record.refundedAmount = newRefundedAmount;
    record.status = isFullRefund ? 'refunded' : 'partially_refunded';
    if (creditsToClawBack > 0) {
      record.refundedCreditsTotal = alreadyClawedBackCredits + creditsToClawBack;
    }
    await record.save();

    if (creditsToClawBack > 0) {
      await this.wallet.applyLedgerEntry(record.organizationId, 'REFUND', -creditsToClawBack, {
        paymentRecordId: record._id.toString(),
        metadata: { refundId: refundDoc._id.toString(), reason: opts.reason, gatewayRefundId: result.gatewayRefundId },
        createdBy: actorUserId,
      });
      refundDoc.creditsClawedBack = creditsToClawBack;
      await refundDoc.save();
    }

    // A full refund voids the invoice this payment generated — a refunded
    // payment shouldn't keep showing as "paid". Partial refunds leave the
    // invoice as-is (it still represents money genuinely collected); the
    // Refund row above is the record of what came back.
    if (isFullRefund) {
      const invoice = await this.invoiceModel.findOne({ paymentRecordId: record._id.toString() }).exec();
      if (invoice && invoice.status === 'paid') {
        invoice.status = 'void';
        invoice.voidedAt = new Date();
        invoice.voidReason = 'Refunded';
        await invoice.save();
      }
    }

    return refundDoc;
  }
}
