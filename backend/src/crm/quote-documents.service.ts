import { BadRequestException, Injectable } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import { createBrandedDocument, drawHeader, drawTable, finalizePagedDocument, sectionHeading } from '../common/pdf/branded-pdf';
import { QuoteDocument } from './schemas/quote.schema';
import { QuotePaymentDocument } from './schemas/quote-payment.schema';
import { QuotePaymentsService } from './quote-payments.service';
import { QuotesService } from './quotes.service';

// SalesBoard's "Get PDF" / "Get Invoice PDF" record actions (Phase 5,
// additive) — same shared PDFKit helpers every other export in this app
// uses (see customer-job-documents.service.ts's identical shape), so these
// two documents look and page-break consistently with everything else
// rather than hand-rolling their own layout.
@Injectable()
export class QuoteDocumentsService {
  constructor(
    private quotesService: QuotesService,
    private quotePaymentsService: QuotePaymentsService,
    private mailService: MailService,
  ) {}

  private money(amount: number, currency: string): string {
    return `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  }

  // The quote/sales-document itself — client, line items (or just the flat
  // total for a synced/legacy quote with none), and totals. Interpreted as
  // the one-page "what was quoted" document a sales rep sends a client,
  // distinct from the Invoice PDF below (what's actually been paid).
  async getQuotePdf(
    organizationId: string,
    id: string,
    storeConstraint?: string,
    ownerConstraint?: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const quote = await this.quotesService.getOne(organizationId, id, storeConstraint, ownerConstraint);
    const buffer = await this.buildQuotePdfBuffer(quote);
    return { buffer, filename: `${quote.quoteNumber ?? quote._id.toString()}.pdf` };
  }

  private async buildQuotePdfBuffer(quote: QuoteDocument): Promise<Buffer> {
    const doc = createBrandedDocument();
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

    drawHeader(doc, { title: `Quote ${quote.quoteNumber ?? ''}`.trim(), subtitle: quote.quoteName });

    sectionHeading(doc, 'Client');
    const client = quote.clientDetails;
    doc.text(client?.companyName ?? 'Not set');
    if (client?.contactName) doc.text(client.contactName);
    if (client?.email) doc.text(client.email);
    if (client?.phone) doc.text(client.phone);

    sectionHeading(doc, 'Details');
    doc.text(`Status: ${quote.quoteStatus}`);
    doc.text(`Client approval: ${quote.clientApprovalStatus}`);
    if (quote.expirationDate) doc.text(`Expires: ${quote.expirationDate}`);
    if (quote.dueDate) doc.text(`Payment deadline: ${quote.dueDate}`);
    if (quote.deliveryDate) doc.text(`Delivery date: ${quote.deliveryDate}`);

    if (quote.items.length > 0) {
      sectionHeading(doc, 'Items');
      drawTable(doc, {
        columns: [
          { label: 'Description', width: 'auto', value: (r: QuoteDocument['items'][number]) => r.description },
          { label: 'Qty', width: 50, align: 'right', value: (r) => r.quantity.toLocaleString() },
          { label: 'Rate', width: 80, align: 'right', value: (r) => this.money(r.unitPrice, quote.currency) },
          { label: 'Total', width: 90, align: 'right', value: (r) => this.money(r.lineTotal, quote.currency) },
        ],
        rows: quote.items,
      });
    }

    sectionHeading(doc, 'Totals');
    doc.text(`Subtotal: ${this.money(quote.subtotal, quote.currency)}`);
    doc.text(`Discount: ${this.money(quote.discountAmount, quote.currency)}`);
    doc.text(`Tax: ${this.money(quote.taxAmount, quote.currency)}`);
    doc.font('Helvetica-Bold').text(`Total: ${this.money(quote.quoteAmount, quote.currency)}`).font('Helvetica');

    finalizePagedDocument(doc);
    return done;
  }

  // "Get Invoice PDF" — interpreted as a receipt-style statement of this
  // quote's payment history (real QuotePayment records only, never a
  // fabricated invoice number/line — this app has no separate Invoice
  // document issued against a Quote; see royalty/invoice.schema.ts's own
  // comment on why that model is the wrong foundation to reuse here).
  async getInvoicePdf(
    organizationId: string,
    id: string,
    storeConstraint?: string,
    ownerConstraint?: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const quote = await this.quotesService.getOne(organizationId, id, storeConstraint, ownerConstraint);
    const payments = await this.quotePaymentsService.listPayments(organizationId, id, storeConstraint, ownerConstraint);
    const doc = createBrandedDocument();
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

    drawHeader(doc, { title: `Payment statement — ${quote.quoteNumber ?? ''}`.trim(), subtitle: quote.clientDetails?.companyName ?? quote.quoteName });

    sectionHeading(doc, 'Quote total');
    doc.text(`Quote amount: ${this.money(quote.quoteAmount, quote.currency)}`);
    doc.text(`Paid to date: ${this.money(quote.paidAmount, quote.currency)}`);
    doc.font('Helvetica-Bold').text(`Outstanding: ${this.money(Math.max(quote.quoteAmount - quote.paidAmount, 0), quote.currency)}`).font('Helvetica');

    sectionHeading(doc, 'Payments');
    if (payments.length === 0) {
      doc.text('No payments recorded yet.');
    } else {
      drawTable(doc, {
        columns: [
          { label: 'Date', width: 90, value: (p: QuotePaymentDocument) => p.paymentDate },
          { label: 'Method', width: 'auto', value: (p) => p.paymentMethod ?? '—' },
          { label: 'Reference', width: 'auto', value: (p) => p.reference ?? '—' },
          { label: 'Amount', width: 90, align: 'right', value: (p) => this.money(p.amount, quote.currency) },
          { label: 'Status', width: 70, value: (p) => (p.voided ? 'Voided' : 'Recorded') },
        ],
        rows: payments,
      });
    }

    finalizePagedDocument(doc);
    const buffer = await done;
    return { buffer, filename: `${quote.quoteNumber ?? quote._id.toString()}-payments.pdf` };
  }

  // "Send" — emails the same document getQuotePdf renders, to the client
  // email already on file (never a client-supplied address — see
  // clientDetails.email's own comment on where that comes from). Refuses
  // outright, rather than silently no-op'ing, when there's no email to send
  // to. On success, a native (non-synced) quote still sitting in 'draft'
  // moves to 'sent' — the one honest, minimal status side effect; a synced
  // quote's quoteStatus is never touched (SYNC_OWNED_FIELDS), and a quote
  // already past 'draft' keeps whatever status it already has.
  async sendQuote(organizationId: string, id: string, storeConstraint?: string): Promise<{ sent: boolean; to: string }> {
    const quote = await this.quotesService.getOne(organizationId, id, storeConstraint);
    const to = quote.clientDetails?.email;
    if (!to) throw new BadRequestException('This quote has no client email on file — add one before sending.');

    const buffer = await this.buildQuotePdfBuffer(quote);
    const filename = `${quote.quoteNumber ?? quote._id.toString()}.pdf`;
    const amount = this.money(quote.quoteAmount, quote.currency);
    const sent = await this.mailService.sendDocumentEmail(to, {
      subject: `Quote ${quote.quoteNumber ?? ''} — ${amount}`.trim(),
      html: `<p>Please find attached quote ${quote.quoteNumber ?? ''} for ${amount}.</p>`,
      text: `Please find attached quote ${quote.quoteNumber ?? ''} for ${amount}.`,
      attachment: { filename, content: buffer },
    });

    if (sent && !quote.externalId && quote.quoteStatus === 'draft') {
      await this.quotesService.updateQuote(organizationId, id, { quoteStatus: 'sent' }, storeConstraint);
    }
    return { sent, to };
  }
}
