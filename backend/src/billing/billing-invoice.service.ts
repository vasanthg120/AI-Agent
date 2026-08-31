import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BillingPlan, BillingPlanDocument } from './schemas/billing-plan.schema';
import { BillingInvoiceCounter, BillingInvoiceCounterDocument } from './schemas/billing-invoice-counter.schema';
import { BillingInvoice, BillingInvoiceDocument } from './schemas/billing-invoice.schema';
import { BillingSettings, BillingSettingsDocument } from './schemas/billing-settings.schema';
import { CreditPackage, CreditPackageDocument } from './schemas/credit-package.schema';
import { InvoiceTemplate, InvoiceTemplateDocument } from './schemas/invoice-template.schema';
import { PaymentRecordDocument } from './schemas/payment-record.schema';

/**
 * Phase 4 — generates exactly one BillingInvoice per CAPTURED PaymentRecord.
 * Called from every place that already grants wallet credits for a payment
 * (BillingService.initiatePurchase/confirmPurchase, BillingSubscriptionsService.
 * activateFromCheckoutPayment, SubscriptionRenewalService, billing-webhook.controller.ts) —
 * an invoice is a byproduct of a successful charge, never generated on its
 * own initiative. Idempotent via the BillingInvoice.paymentRecordId unique
 * index, same insert-then-catch-duplicate-key convention as
 * CouponsService.recordRedemption/billing-webhook.controller.ts's WebhookEvent.
 */
@Injectable()
export class BillingInvoiceService {
  constructor(
    @InjectModel(BillingInvoice.name) private invoiceModel: Model<BillingInvoiceDocument>,
    @InjectModel(BillingInvoiceCounter.name) private counterModel: Model<BillingInvoiceCounterDocument>,
    @InjectModel(BillingSettings.name) private settingsModel: Model<BillingSettingsDocument>,
    @InjectModel(CreditPackage.name) private packageModel: Model<CreditPackageDocument>,
    @InjectModel(BillingPlan.name) private planModel: Model<BillingPlanDocument>,
    @InjectModel(InvoiceTemplate.name) private templateModel: Model<InvoiceTemplateDocument>,
  ) {}

  async generateForPaymentRecord(record: PaymentRecordDocument): Promise<BillingInvoiceDocument> {
    const existing = await this.invoiceModel.findOne({ paymentRecordId: record._id.toString() }).exec();
    if (existing) return existing;

    const settings = await this.getOrCreateSettings();
    const description = await this.describeLineItem(record);
    const subtotal = record.amount + (record.couponDiscountAmount ?? 0);
    const invoiceNumber = await this.nextInvoiceNumber(settings.invoiceNumberPrefix, settings.invoiceNumberStart);
    const now = new Date();

    try {
      return await this.invoiceModel.create({
        organizationId: record.organizationId,
        invoiceNumber,
        type: record.type,
        paymentRecordId: record._id.toString(),
        subscriptionId: record.subscriptionId,
        status: 'paid',
        currencyCode: record.currency,
        subtotal,
        discountAmount: record.couponDiscountAmount ?? 0,
        couponId: record.couponId,
        taxAmount: 0, // no tax computation is wired into checkout yet (see TaxRate's own Phase 1 scope note)
        total: record.amount,
        items: [{ description, quantity: 1, unitAmount: subtotal, amount: subtotal }],
        billingSnapshot: {
          companyName: settings.companyName,
          companyLogoUrl: settings.companyLogoUrl,
          companyAddress: settings.companyAddress,
          companyEmail: settings.companyEmail,
          companyTaxId: settings.companyTaxId,
          footerText: settings.invoiceFooterText,
          termsText: settings.invoiceTermsText,
        },
        issuedAt: now,
        paidAt: now,
      });
    } catch (err) {
      const mongoErr = err as { code?: number };
      if (mongoErr.code === 11000) {
        // Lost a race to another concurrent call generating this same
        // PaymentRecord's invoice — return what it created instead of
        // erroring or double-issuing a second invoice number.
        const raced = await this.invoiceModel.findOne({ paymentRecordId: record._id.toString() }).exec();
        if (raced) return raced;
      }
      throw err;
    }
  }

  listForOrganization(organizationId: string, limit = 50) {
    return this.invoiceModel.find({ organizationId }).sort({ issuedAt: -1 }).limit(limit).exec();
  }

  async getForOrganization(organizationId: string, invoiceId: string): Promise<BillingInvoiceDocument> {
    const invoice = await this.invoiceModel.findOne({ _id: invoiceId, organizationId }).exec();
    if (!invoice) throw new NotFoundException('Invoice not found.');
    return invoice;
  }

  /** Upserts the single BillingSettings document — see that schema's
   * singletonKey comment. Called both by invoice generation (read-only
   * here) and by BillingAdminSettingsService (read/write). */
  async getOrCreateSettings(): Promise<BillingSettingsDocument> {
    const settings = await this.settingsModel.findOneAndUpdate(
      { singletonKey: 'default' },
      { $setOnInsert: { singletonKey: 'default' } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();
    return settings;
  }

  /** Best-effort — null just means the PDF renders with built-in defaults
   * (see BillingInvoicePdfService). Never blocks invoice generation/viewing
   * on a missing/misconfigured template. */
  getDefaultTemplate(): Promise<InvoiceTemplateDocument | null> {
    return this.templateModel.findOne({ isDefault: true, active: true }).exec();
  }

  /** Second export format alongside the existing PDF (BillingInvoicePdfService)
   * — plain string building, no new dependency. One header block, one row
   * per line item, one totals row; RFC 4180 field quoting (only where a
   * value actually contains a comma/quote/newline) so a company name or
   * line-item description with a comma can't corrupt the column count. */
  toCsv(invoice: BillingInvoiceDocument): string {
    const csvField = (value: string | number): string => {
      const str = String(value);
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const row = (cells: (string | number)[]): string => cells.map(csvField).join(',') + '\r\n';

    let csv = row(['Invoice Number', 'Status', 'Issued At', 'Currency', 'Organization Id']);
    csv += row([invoice.invoiceNumber, invoice.status, invoice.issuedAt.toISOString(), invoice.currencyCode, invoice.organizationId]);
    csv += '\r\n';
    csv += row(['Description', 'Quantity', 'Unit Amount', 'Amount']);
    for (const item of invoice.items) {
      csv += row([item.description, item.quantity, item.unitAmount, item.amount]);
    }
    csv += '\r\n';
    csv += row(['Subtotal', invoice.subtotal]);
    if (invoice.discountAmount) csv += row(['Discount', -invoice.discountAmount]);
    if (invoice.taxAmount) csv += row(['Tax', invoice.taxAmount]);
    csv += row(['Total', invoice.total]);
    return csv;
  }

  private async nextInvoiceNumber(prefix: string, start: number): Promise<string> {
    const counter = await this.counterModel
      .findOneAndUpdate({ key: 'global' }, { $inc: { seq: 1 } }, { upsert: true, new: true })
      .exec();
    return `${prefix}-${start + counter.seq}`;
  }

  private async describeLineItem(record: PaymentRecordDocument): Promise<string> {
    if (record.type === 'purchase' || record.type === 'autopay') {
      const pkg = record.creditPackageId ? await this.packageModel.findOne({ key: record.creditPackageId }).exec() : null;
      const label = record.type === 'autopay' ? 'Auto Recharge' : (pkg?.name ?? 'Credit purchase');
      return `${label} — ${record.creditsGranted} Haive Credits`;
    }
    const plan = record.subscriptionPlanId ? await this.planModel.findById(record.subscriptionPlanId).exec() : null;
    const cycleLabel = record.type === 'subscription_renewal' ? 'renewal' : 'subscription';
    return plan ? `${plan.name} plan — ${cycleLabel}` : `Subscription ${cycleLabel}`;
  }
}
