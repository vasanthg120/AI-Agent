import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BillingInvoice, BillingInvoiceDocument } from './schemas/billing-invoice.schema';

/**
 * Phase 4 admin surface — unscoped (any organization's invoices), unlike
 * BillingInvoiceService's customer-facing methods which always filter by
 * organizationId. Gated entirely by
 * billing-admin-invoices.controller.ts's @Roles('platform_admin').
 */
@Injectable()
export class BillingAdminInvoicesService {
  constructor(@InjectModel(BillingInvoice.name) private invoiceModel: Model<BillingInvoiceDocument>) {}

  list(filters: { organizationId?: string; status?: string; limit?: number }) {
    const query: Record<string, unknown> = {};
    if (filters.organizationId) query.organizationId = filters.organizationId;
    if (filters.status) query.status = filters.status;
    return this.invoiceModel
      .find(query)
      .sort({ issuedAt: -1 })
      .limit(filters.limit ?? 100)
      .exec();
  }

  async get(id: string): Promise<BillingInvoiceDocument> {
    const invoice = await this.invoiceModel.findById(id).exec();
    if (!invoice) throw new NotFoundException('Invoice not found.');
    return invoice;
  }

  /** Marks an invoice void — a bookkeeping/display flag only. Does NOT
   * reverse the underlying wallet credit grant or trigger a gateway refund;
   * that's a separate, explicit admin action (a future Phase 6
   * RefundService), since voiding a mis-issued invoice and refunding actual
   * money are different decisions an admin might make independently. */
  async voidInvoice(id: string, reason?: string): Promise<BillingInvoiceDocument> {
    const invoice = await this.invoiceModel
      .findByIdAndUpdate(id, { $set: { status: 'void', voidedAt: new Date(), voidReason: reason } }, { new: true })
      .exec();
    if (!invoice) throw new NotFoundException('Invoice not found.');
    return invoice;
  }
}
