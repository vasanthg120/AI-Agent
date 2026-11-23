import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PaymentEvents } from '../common/payments/payment-events';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Quote, QuoteDocument } from './schemas/quote.schema';
import { QuotePayment, QuotePaymentDocument } from './schemas/quote-payment.schema';
import { RecordQuotePaymentDto } from './dto/record-quote-payment.dto';
import { QuotesService } from './quotes.service';

// Owns the real, itemized customer-payment history against a Quote — see
// quote-payment.schema.ts's own comment for why this lives here (CrmModule)
// rather than as a Royalty Invoice extension. Quote.paidAmount is always
// recomputed by summing non-voided payments (never incrementally $inc'd),
// same "never trust an incremental total, always recompute" convention as
// finance-dashboard.service.ts's own aging math.
@Injectable()
export class QuotePaymentsService {
  constructor(
    @InjectModel(Quote.name) private quoteModel: Model<QuoteDocument>,
    @InjectModel(QuotePayment.name) private paymentModel: Model<QuotePaymentDocument>,
    private quotesService: QuotesService,
    @Optional() private paymentEvents?: PaymentEvents,
  ) {}

  async recordPayment(
    organizationId: string,
    quoteId: string,
    dto: RecordQuotePaymentDto,
    recordedBy: string,
    storeConstraint?: string,
  ): Promise<QuotePaymentDocument> {
    // Scope check first — a manager recording a payment against a quote
    // outside their store must get the same 404 as any other scoped lookup
    // in this app, never a silent cross-store write.
    await this.quotesService.getOne(organizationId, quoteId, storeConstraint);

    const payment = await this.paymentModel.create({
      organizationId,
      quoteId,
      amount: dto.amount,
      paymentDate: dto.paymentDate,
      paymentMethod: dto.paymentMethod,
      reference: dto.reference,
      recordedBy,
    });
    await this.recomputePaidAmount(organizationId, quoteId);
    return payment;
  }

  async listPayments(
    organizationId: string,
    quoteId: string,
    storeConstraint?: string,
    ownerConstraint?: string,
  ): Promise<QuotePaymentDocument[]> {
    await this.quotesService.getOne(organizationId, quoteId, storeConstraint, ownerConstraint);
    return this.paymentModel.find({ organizationId, quoteId }).sort({ paymentDate: -1 }).exec();
  }

  async voidPayment(
    organizationId: string,
    quoteId: string,
    paymentId: string,
    voidedBy: string,
    reason: string | undefined,
    storeConstraint?: string,
  ): Promise<QuotePaymentDocument> {
    await this.quotesService.getOne(organizationId, quoteId, storeConstraint);

    const payment = await this.paymentModel.findOne({ _id: paymentId, organizationId, quoteId }).exec();
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.voided) throw new BadRequestException('Payment is already voided');

    payment.voided = true;
    payment.voidedAt = new Date();
    payment.voidedBy = voidedBy;
    payment.voidReason = reason;
    await payment.save();
    await this.recomputePaidAmount(organizationId, quoteId);
    return payment;
  }

  // Business Intelligence's per-customer detail (customer-quote-payment.service.ts)
  // overlays each quote in a relationship view with its own real payment
  // history — grouped by quoteId so the caller never has to N+1 query.
  async listPaymentsForQuotes(organizationId: string, quoteIds: string[]): Promise<Map<string, QuotePaymentDocument[]>> {
    if (quoteIds.length === 0) return new Map();
    const payments = await this.paymentModel
      .find({ organizationId, quoteId: { $in: quoteIds } })
      .sort({ paymentDate: -1 })
      .exec();
    const byQuote = new Map<string, QuotePaymentDocument[]>();
    for (const p of payments) {
      if (!byQuote.has(p.quoteId)) byQuote.set(p.quoteId, []);
      byQuote.get(p.quoteId)!.push(p);
    }
    return byQuote;
  }

  private async recomputePaidAmount(organizationId: string, quoteId: string): Promise<void> {
    const rows = await this.paymentModel
      .aggregate<{ _id: null; total: number }>([
        { $match: { organizationId, quoteId, voided: false } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ])
      .exec();
    const total = rows[0]?.total ?? 0;
    await this.quoteModel.updateOne({ _id: quoteId, organizationId }, { $set: { paidAmount: total } }).exec();
    // A recorded (or voided) payment changes what the quote has been paid — the reconciliation re-derives its status.
    this.paymentEvents?.notify(organizationId, 'quote-payment');
  }
}
