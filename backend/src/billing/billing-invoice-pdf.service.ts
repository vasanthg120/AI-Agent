import { Injectable } from '@nestjs/common';
import { BillingInvoiceDocument } from './schemas/billing-invoice.schema';
import { InvoiceTemplateDocument } from './schemas/invoice-template.schema';

function money(amount: number, currencyCode: string): string {
  return `${currencyCode} ${amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Mirrors royalty/royalty-report-export.service.ts's writePdf shape exactly
// (same pdfkit call style: fontSize/fillColor/text chains against a caller-
// supplied PDFKit.PDFDocument, no return value — the controller owns
// piping/headers/doc.end()). template is optional — a null template just
// means the built-in defaults (accent color, show-tax-breakdown, show-logo)
// apply, so PDF generation never hard-fails on a missing/inactive template.
@Injectable()
export class BillingInvoicePdfService {
  writePdf(doc: PDFKit.PDFDocument, invoice: BillingInvoiceDocument, template: InvoiceTemplateDocument | null): void {
    const accent = template?.accentColorHex || '#4F46E5';
    const showTax = template?.showTaxBreakdown ?? true;
    const showLogo = template?.showLogo ?? true;

    doc.fontSize(20).fillColor(accent).text(invoice.billingSnapshot.companyName);
    doc.fontSize(9).fillColor('#666');
    if (invoice.billingSnapshot.companyAddress) doc.text(invoice.billingSnapshot.companyAddress);
    if (invoice.billingSnapshot.companyEmail) doc.text(invoice.billingSnapshot.companyEmail);
    if (invoice.billingSnapshot.companyTaxId) doc.text(`Tax ID: ${invoice.billingSnapshot.companyTaxId}`);
    doc.moveDown();

    // Logo embedding is a fast-follow: pdfkit's doc.image() needs a local
    // buffer/file path, not an arbitrary remote URL — wiring this up
    // properly needs BillingSettings.companyLogoUrl to be backed by an
    // actual uploaded/fetchable asset first, not just a string field.
    void showLogo;

    doc.fontSize(16).fillColor('#000').text(`Invoice ${invoice.invoiceNumber}`);
    doc.fontSize(9).fillColor('#666').text(`Issued: ${invoice.issuedAt.toISOString().slice(0, 10)}`);
    doc.text(`Status: ${invoice.status.toUpperCase()}`);
    doc.moveDown();

    doc.fontSize(11).fillColor('#000').text('Items');
    doc.moveDown(0.3);
    for (const item of invoice.items) {
      doc
        .fontSize(10)
        .fillColor('#000')
        .text(item.description, { continued: true, width: 320 })
        .fillColor('#333')
        .text(`  ${money(item.amount, invoice.currencyCode)}`);
    }
    doc.moveDown();

    doc.fontSize(10).fillColor('#000').text(`Subtotal: ${money(invoice.subtotal, invoice.currencyCode)}`);
    if (invoice.discountAmount > 0) {
      doc.fillColor('#0a7a3c').text(`Discount: -${money(invoice.discountAmount, invoice.currencyCode)}`);
    }
    if (showTax && invoice.taxAmount > 0) {
      doc.fillColor('#000').text(`Tax: ${money(invoice.taxAmount, invoice.currencyCode)}`);
    }
    doc.moveDown(0.3);
    doc.fontSize(13).fillColor(accent).text(`Total: ${money(invoice.total, invoice.currencyCode)}`);

    if (invoice.billingSnapshot.footerText || invoice.billingSnapshot.termsText) {
      doc.moveDown();
      doc.fontSize(8).fillColor('#999');
      if (invoice.billingSnapshot.footerText) doc.text(invoice.billingSnapshot.footerText);
      if (invoice.billingSnapshot.termsText) doc.text(invoice.billingSnapshot.termsText);
    }
  }
}
