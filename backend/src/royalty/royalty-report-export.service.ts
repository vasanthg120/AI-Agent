import { Injectable } from '@nestjs/common';
import { Parser } from 'json2csv';
import ExcelJS from 'exceljs';
import { BRAND, drawHeader, drawTable, sectionHeading } from '../common/pdf/branded-pdf';
import { RoyaltyReportSummary } from './royalty-report.service';

export interface RoyaltyReportExportRow {
  item: string;
  value: string;
}

function money(value: number): string {
  return `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Mirrors crm/deals-export.service.ts's / finance/finance-export.service.ts's
// exact 4-method shape (json2csv for CSV, pdfkit via the shared branded-pdf
// helpers for PDF, exceljs for Excel) — the same proven export pattern.
@Injectable()
export class RoyaltyReportExportService {
  buildRows(report: RoyaltyReportSummary): RoyaltyReportExportRow[] {
    const rows: RoyaltyReportExportRow[] = [
      { item: 'Total Quotes', value: String(report.totalQuotes) },
      { item: 'Total Not Accepted Quotes', value: String(report.totalNotAcceptedQuotes) },
      { item: 'Total Deals', value: String(report.totalDeals) },
      { item: 'Total Invoices', value: String(report.totalInvoices) },
      { item: 'Total Void Invoices', value: String(report.totalVoidInvoices) },
      { item: 'Value of Currently Voided Invoices', value: money(report.valueOfVoidedInvoices) },
      { item: 'Value of Work In Progress', value: money(report.workInProgressValue) },
      { item: 'Gross Revenue', value: money(report.grossRevenue) },
      { item: 'Eligible Revenue', value: money(report.eligibleRevenue) },
      { item: 'Royalty Percentage', value: report.royaltyRule ? `${report.royaltyRule.royaltyPercentage}%` : '—' },
      { item: 'Royalty Fee (before cap)', value: money(report.royaltyFeeBeforeCap) },
      { item: 'Total Due', value: money(report.totalDue) },
      {
        item: 'Effective Royalty % (after cap)',
        value: report.effectiveRoyaltyPct !== null ? `${report.effectiveRoyaltyPct}%` : '—',
      },
    ];
    if (report.marketingFeeAmount !== null) rows.push({ item: 'Marketing Fee', value: money(report.marketingFeeAmount) });
    if (report.otherFeeAmount !== null) rows.push({ item: 'Other Fee', value: money(report.otherFeeAmount) });
    return rows;
  }

  toCsv(rows: RoyaltyReportExportRow[]): string {
    const parser = new Parser({ fields: ['item', 'value'] });
    return parser.parse(rows);
  }

  // Takes the full report (not just the Executive Summary rows) so the PDF
  // can show real Deals/Invoices/WIP tables — previously the PDF was
  // Executive-Summary-only (a bullet label/value list) while the Excel
  // export already had 4 real sheets; this brings the PDF to real parity.
  writePdf(doc: PDFKit.PDFDocument, rows: RoyaltyReportExportRow[], meta: { dateFrom: string; dateTo: string }, report: RoyaltyReportSummary): void {
    drawHeader(doc, {
      title: 'Royalty Report',
      subtitle: `Period: ${meta.dateFrom} – ${meta.dateTo}\nReport run: ${new Date().toISOString().slice(0, 10)}`,
    });

    sectionHeading(doc, 'Executive Summary');
    drawTable(doc, {
      columns: [
        { label: 'Item', width: 'auto', align: 'left', value: (r: RoyaltyReportExportRow) => r.item },
        { label: 'Value', width: 150, align: 'right', value: (r: RoyaltyReportExportRow) => r.value },
      ],
      rows,
    });

    if (report.deals.length > 0) {
      sectionHeading(doc, `Deals (${report.dealsSummary.totalRecords}) — ${money(report.dealsSummary.totalSalesExTax)}`);
      drawTable(doc, {
        columns: [
          { label: 'Customer', width: 'auto', align: 'left', value: (d) => d.customerName },
          { label: 'Quote #', width: 70, align: 'left', value: (d) => d.quoteNumber ?? '—' },
          { label: 'Status', width: 55, align: 'left', value: (d) => d.dealStatus },
          { label: 'Value', width: 85, align: 'right', value: (d) => money(d.value) },
          { label: 'Closing Date', width: 75, align: 'left', value: (d) => d.closingDate ?? '—' },
        ],
        rows: report.deals,
      });
    }

    if (report.invoices.length > 0) {
      sectionHeading(doc, `Invoices (${report.invoicesSummary.totalRecords}) — ${money(report.invoicesSummary.totalSalesExTax)}`);
      drawTable(doc, {
        columns: [
          { label: 'Invoice #', width: 70, align: 'left', value: (i) => i.invoiceNumber },
          { label: 'Customer', width: 'auto', align: 'left', value: (i) => i.customerName },
          { label: 'Ex Tax Value', width: 75, align: 'right', value: (i) => money(i.exTaxValue) },
          { label: 'Eligible', width: 70, align: 'right', value: (i) => money(i.eligibleValue) },
          { label: 'Royalty', width: 70, align: 'right', value: (i) => money(i.royalty) },
          { label: 'Status', width: 55, align: 'left', value: (i) => (i.voidStatus ? 'Voided' : i.invoiceStatus) },
        ],
        rows: report.invoices,
      });
    }

    if (report.wipQuotes.length > 0) {
      sectionHeading(doc, `Work In Progress (${report.wipQuotesSummary.totalRecords}) — ${money(report.wipQuotesSummary.totalSalesExTax)}`);
      drawTable(doc, {
        columns: [
          { label: 'Quote #', width: 80, align: 'left', value: (q) => q.quoteNumber ?? '—' },
          { label: 'Customer', width: 'auto', align: 'left', value: (q) => q.customerName },
          { label: 'Created Date', width: 90, align: 'left', value: (q) => q.createdDate },
          { label: 'Quote Total (Ex Tax)', width: 110, align: 'right', value: (q) => money(q.quoteTotalExTax) },
        ],
        rows: report.wipQuotes,
      });
    }

    if (report.deals.length === 0 && report.invoices.length === 0 && report.wipQuotes.length === 0) {
      doc.moveDown(0.5).fontSize(10).fillColor(BRAND.muted).text('No itemized deal, invoice, or work-in-progress records in this period.');
    }
  }

  // Four sheets — Executive Summary (label/value, as CSV/PDF also show),
  // Deals, Invoices, and Work In Progress (Quotes) — the itemized line data
  // the summary's counts/sums are aggregated from, each ending in its own
  // Summary row (record count + Total Sales Ex Tax).
  async toExcel(rows: RoyaltyReportExportRow[], report: RoyaltyReportSummary): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();

    const summarySheet = workbook.addWorksheet('Executive Summary');
    summarySheet.addRow(['Royalty Report']);
    summarySheet.addRow([`Period: ${report.dateFrom} – ${report.dateTo}`]);
    summarySheet.addRow([]);
    summarySheet.addRow(['Item', 'Value']);
    for (const row of rows) {
      summarySheet.addRow([row.item, row.value]);
    }
    summarySheet.getColumn(1).width = 32;
    summarySheet.getColumn(2).width = 22;

    const dealsSheet = workbook.addWorksheet('Deals');
    dealsSheet.addRow(['Customer', 'Quote #', 'Status', 'Value', 'Closing Date', 'Created Date']);
    for (const d of report.deals) {
      dealsSheet.addRow([d.customerName, d.quoteNumber ?? '—', d.dealStatus, d.value, d.closingDate ?? '—', d.createdDate]);
    }
    dealsSheet.addRow([]);
    dealsSheet.addRow(['Summary']);
    dealsSheet.addRow(['Total Records', report.dealsSummary.totalRecords]);
    dealsSheet.addRow(['Total Sales (Ex Tax)', report.dealsSummary.totalSalesExTax]);
    for (let i = 1; i <= 6; i++) dealsSheet.getColumn(i).width = 22;

    const invoicesSheet = workbook.addWorksheet('Invoices');
    invoicesSheet.addRow([
      'Invoice #',
      'Customer',
      'Quote #',
      'Invoice Date',
      'Created Date',
      'Previous Value',
      'Updated Value',
      'Ex Tax Value',
      'Eligible Value',
      'Royalty',
      'Status',
      'Voided',
    ]);
    for (const inv of report.invoices) {
      invoicesSheet.addRow([
        inv.invoiceNumber,
        inv.customerName,
        inv.quoteNumber ?? '—',
        inv.invoiceDate,
        inv.createdDate,
        inv.previousValue ?? '—',
        inv.currentValue,
        inv.exTaxValue,
        inv.eligibleValue,
        inv.royalty,
        inv.invoiceStatus,
        inv.voidStatus ? 'Yes' : 'No',
      ]);
    }
    invoicesSheet.addRow([]);
    invoicesSheet.addRow(['Summary']);
    invoicesSheet.addRow(['Total Records', report.invoicesSummary.totalRecords]);
    invoicesSheet.addRow(['Total Sales (Ex Tax)', report.invoicesSummary.totalSalesExTax]);
    for (let i = 1; i <= 12; i++) invoicesSheet.getColumn(i).width = 16;

    const wipSheet = workbook.addWorksheet('Work In Progress');
    wipSheet.addRow(['Quote #', 'Customer', 'Created Date', 'Quote Total (Ex Tax)', 'Tax']);
    for (const q of report.wipQuotes) {
      wipSheet.addRow([q.quoteNumber ?? '—', q.customerName, q.createdDate, q.quoteTotalExTax, q.tax ?? '—']);
    }
    wipSheet.addRow([]);
    wipSheet.addRow(['Summary']);
    wipSheet.addRow(['Total Records', report.wipQuotesSummary.totalRecords]);
    wipSheet.addRow(['Total Sales (Ex Tax)', report.wipQuotesSummary.totalSalesExTax]);
    for (let i = 1; i <= 5; i++) wipSheet.getColumn(i).width = 22;

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
