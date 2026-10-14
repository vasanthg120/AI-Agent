import { Injectable } from '@nestjs/common';
import { Parser } from 'json2csv';
import ExcelJS from 'exceljs';
import { BRAND, drawHeader, drawTable, sectionHeading } from '../common/pdf/branded-pdf';
import { RoyaltyReportQuotationLine, RoyaltyReportSummary } from './royalty-report.service';

export interface RoyaltyReportExportRow {
  item: string;
  value: string;
}

function money(value: number): string {
  return `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const statusOf = (q: RoyaltyReportQuotationLine) => (q.accepted ? 'Accepted' : 'Not accepted yet');

// Mirrors crm/deals-export.service.ts's / finance/finance-export.service.ts's
// exact 4-method shape (json2csv for CSV, pdfkit via the shared branded-pdf
// helpers for PDF, exceljs for Excel) — the same proven export pattern.
@Injectable()
export class RoyaltyReportExportService {
  // The Executive Summary, line for line as the page shows it
  // (frontend RoyaltyReportSection's buildReportLines — kept in step deliberately).
  buildRows(report: RoyaltyReportSummary): RoyaltyReportExportRow[] {
    const rows: RoyaltyReportExportRow[] = [
      { item: 'Quotations Sent', value: String(report.totalQuotes) },
      { item: 'Accepted Quotations', value: String(report.totalAcceptedQuotes) },
      { item: 'Not Accepted Yet', value: String(report.totalNotAcceptedQuotes) },
      { item: 'Sales (Ex Tax)', value: money(report.salesExTax) },
      { item: 'Tax', value: money(report.tax) },
      { item: 'Sales (Including Tax)', value: money(report.salesIncTax) },
      { item: 'Royalty Charged On', value: report.royaltyBase === 'exTax' ? 'Sales (Ex Tax)' : 'Sales (Including Tax)' },
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

  // The Executive Summary, then every quotation it is added up from.
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

    if (report.quotations.length === 0) {
      doc.moveDown(0.5).fontSize(10).fillColor(BRAND.muted).text('No quotation was sent in this period.');
      return;
    }
    sectionHeading(doc, `Quotations (${report.quotationsSummary.totalRecords}) — ${money(report.quotationsSummary.totalSalesExTax)} ex tax`);
    drawTable(doc, {
      columns: [
        { label: 'Quote #', width: 55, align: 'left', value: (q: RoyaltyReportQuotationLine) => q.quoteNumber ?? '—' },
        { label: 'Customer', width: 'auto', align: 'left', value: (q: RoyaltyReportQuotationLine) => q.customerName },
        { label: 'Date', width: 58, align: 'left', value: (q: RoyaltyReportQuotationLine) => q.date },
        { label: 'Ex Tax', width: 70, align: 'right', value: (q: RoyaltyReportQuotationLine) => money(q.salesExTax) },
        { label: 'Tax', width: 60, align: 'right', value: (q: RoyaltyReportQuotationLine) => money(q.tax) },
        { label: 'Inc Tax', width: 72, align: 'right', value: (q: RoyaltyReportQuotationLine) => money(q.salesIncTax) },
        { label: 'Royalty', width: 60, align: 'right', value: (q: RoyaltyReportQuotationLine) => money(q.royalty) },
      ],
      rows: report.quotations,
    });
  }

  // Two sheets: the Executive Summary (as the CSV and the PDF show it), and the
  // quotations it is added up from, ending in their own totals.
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
    summarySheet.getColumn(2).width = 24;

    const sheet = workbook.addWorksheet('Quotations');
    sheet.addRow(['Quote #', 'Customer', 'Date', 'Status', 'Sales (Ex Tax)', 'Tax', 'Sales (Including Tax)', 'Royalty']);
    for (const q of report.quotations) {
      sheet.addRow([q.quoteNumber ?? '—', q.customerName, q.date, statusOf(q), q.salesExTax, q.tax, q.salesIncTax, q.royalty]);
    }
    sheet.addRow([]);
    sheet.addRow(['Summary']);
    sheet.addRow(['Total Records', report.quotationsSummary.totalRecords]);
    sheet.addRow(['Sales (Ex Tax)', report.quotationsSummary.totalSalesExTax]);
    sheet.addRow(['Tax', report.quotationsSummary.totalTax]);
    sheet.addRow(['Sales (Including Tax)', report.quotationsSummary.totalSalesIncTax]);
    sheet.addRow(['Royalty (before cap)', report.quotationsSummary.totalRoyalty]);
    for (let i = 1; i <= 8; i++) sheet.getColumn(i).width = i === 2 ? 34 : 20;

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
