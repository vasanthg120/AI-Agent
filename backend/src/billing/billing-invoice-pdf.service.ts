import { Injectable } from '@nestjs/common';
import { BRAND, drawHeader, drawTable, sectionHeading } from '../common/pdf/branded-pdf';
import { BillingInvoiceDocument } from './schemas/billing-invoice.schema';
import { InvoiceTemplateDocument } from './schemas/invoice-template.schema';

function money(amount: number, currencyCode: string): string {
  return `${currencyCode} ${amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// template is optional — a null template just means the built-in defaults
// (accent color, show-tax-breakdown, show-logo) apply, so PDF generation
// never hard-fails on a missing/inactive template. Rendering goes through
// the shared branded-pdf helpers (see backend/src/common/pdf/branded-pdf.ts)
// — the controller still owns piping/headers/finalizing the document.
@Injectable()
export class BillingInvoicePdfService {
  writePdf(doc: PDFKit.PDFDocument, invoice: BillingInvoiceDocument, template: InvoiceTemplateDocument | null): void {
    const accent = template?.accentColorHex || BRAND.accent;
    const showTax = template?.showTaxBreakdown ?? true;
    const showLogo = template?.showLogo ?? true;

    const subtitle = [
      invoice.billingSnapshot.companyAddress,
      invoice.billingSnapshot.companyEmail,
      invoice.billingSnapshot.companyTaxId ? `Tax ID: ${invoice.billingSnapshot.companyTaxId}` : undefined,
    ]
      .filter(Boolean)
      .join('\n');

    drawHeader(doc, { title: invoice.billingSnapshot.companyName, subtitle: subtitle || undefined, accentHex: accent, showLogo });

    doc.font('Helvetica-Bold').fontSize(14).fillColor(BRAND.ink).text(`Invoice ${invoice.invoiceNumber}`);
    doc.font('Helvetica').fontSize(9).fillColor(BRAND.muted).text(`Issued: ${invoice.issuedAt.toISOString().slice(0, 10)}`);
    doc.text(`Status: ${invoice.status.toUpperCase()}`);
    doc.moveDown();

    sectionHeading(doc, 'Items');
    drawTable(doc, {
      accentHex: accent,
      columns: [
        { label: 'Description', width: 'auto', align: 'left', value: (item) => item.description },
        { label: 'Amount', width: 110, align: 'right', value: (item) => money(item.amount, invoice.currencyCode) },
      ],
      rows: invoice.items,
    });

    doc.font('Helvetica').fontSize(10).fillColor(BRAND.ink).text(`Subtotal: ${money(invoice.subtotal, invoice.currencyCode)}`, { align: 'right' });
    if (invoice.discountAmount > 0) {
      doc.fillColor('#0a7a3c').text(`Discount: -${money(invoice.discountAmount, invoice.currencyCode)}`, { align: 'right' });
    }
    if (showTax && invoice.taxAmount > 0) {
      doc.fillColor(BRAND.ink).text(`Tax: ${money(invoice.taxAmount, invoice.currencyCode)}`, { align: 'right' });
    }
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(accent).text(`Total: ${money(invoice.total, invoice.currencyCode)}`, { align: 'right' });

    if (invoice.billingSnapshot.footerText || invoice.billingSnapshot.termsText) {
      doc.moveDown();
      doc.font('Helvetica').fontSize(8).fillColor(BRAND.muted);
      if (invoice.billingSnapshot.footerText) doc.text(invoice.billingSnapshot.footerText);
      if (invoice.billingSnapshot.termsText) doc.text(invoice.billingSnapshot.termsText);
    }
  }
}
