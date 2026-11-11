import { Injectable } from '@nestjs/common';
import { Parser } from 'json2csv';
import ExcelJS from 'exceljs';
import { BRAND, drawHeader, drawTable, sectionHeading } from '../common/pdf/branded-pdf';
import { RoyaltyReportSaleLine, RoyaltyReportSummary } from './royalty-report.service';

export interface RoyaltyReportExportRow {
  item: string;
  value: string;
}

const SYMBOL: Record<string, string> = { INR: '₹', AUD: 'A$', NZD: 'NZ$', USD: '$', GBP: '£', EUR: '€' };
const LOCALE: Record<string, string> = { INR: 'en-IN', AUD: 'en-AU', NZD: 'en-NZ', GBP: 'en-GB' };

// In the report's own currency (the shown CRM's: Pantheras INR, Hoops AUD), grouped the way that country writes it.
function money(value: number, currency = 'INR'): string {
  const code = currency.toUpperCase();
  const amount = value.toLocaleString(LOCALE[code] ?? 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${SYMBOL[code] ?? `${code} `}${amount}`;
}

// Mirrors crm/deals-export.service.ts's / finance/finance-export.service.ts's
// exact 4-method shape (json2csv for CSV, pdfkit via the shared branded-pdf
// helpers for PDF, exceljs for Excel) — the same proven export pattern.
@Injectable()
export class RoyaltyReportExportService {
  // The Executive Summary, line for line as the page shows it
  // (frontend RoyaltyReportSection's buildReportLines — kept in step deliberately).
  buildRows(report: RoyaltyReportSummary): RoyaltyReportExportRow[] {
    const rows: RoyaltyReportExportRow[] = [
      { item: 'Deals Won', value: String(report.wonDeals) },
      { item: 'Sales (Ex Tax)', value: money(report.salesExTax, report.currency) },
      { item: 'Tax', value: money(report.tax, report.currency) },
      { item: 'Sales (Including Tax)', value: money(report.salesIncTax, report.currency) },
      { item: 'Royalty Charged On', value: report.royaltyBase === 'exTax' ? 'Sales (Ex Tax)' : 'Sales (Including Tax)' },
      { item: 'Royalty Percentage', value: report.royaltyRule ? `${report.royaltyRule.royaltyPercentage}%` : '—' },
      { item: 'Royalty Fee (before cap)', value: money(report.royaltyFeeBeforeCap, report.currency) },
      { item: 'Total Due', value: money(report.totalDue, report.currency) },
      {
        item: 'Effective Royalty % (after cap)',
        value: report.effectiveRoyaltyPct !== null ? `${report.effectiveRoyaltyPct}%` : '—',
      },
    ];
    if (report.marketingFeeAmount !== null) rows.push({ item: 'Marketing Fee', value: money(report.marketingFeeAmount, report.currency) });
    if (report.otherFeeAmount !== null) rows.push({ item: 'Other Fee', value: money(report.otherFeeAmount, report.currency) });
    return rows;
  }

  toCsv(rows: RoyaltyReportExportRow[]): string {
    const parser = new Parser({ fields: ['item', 'value'] });
    return parser.parse(rows);
  }

  // The Executive Summary, then every won deal it is added up from.
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

    if (report.sales.length === 0) {
      doc.moveDown(0.5).fontSize(10).fillColor(BRAND.muted).text('No deal was won in this period.');
      return;
    }
    sectionHeading(doc, `Deals won (${report.salesSummary.totalRecords}) — ${money(report.salesSummary.totalSalesExTax, report.currency)} ex tax`);
    drawTable(doc, {
      columns: [
        { label: 'Customer', width: 'auto', align: 'left', value: (l: RoyaltyReportSaleLine) => l.customerName },
        { label: 'Closed', width: 58, align: 'left', value: (l: RoyaltyReportSaleLine) => l.date },
        { label: 'Quote #', width: 50, align: 'left', value: (l: RoyaltyReportSaleLine) => l.quoteNumbers ?? '—' },
        { label: 'Ex Tax', width: 70, align: 'right', value: (l: RoyaltyReportSaleLine) => money(l.salesExTax, report.currency) },
        { label: 'Tax', width: 60, align: 'right', value: (l: RoyaltyReportSaleLine) => money(l.tax, report.currency) },
        { label: 'Inc Tax', width: 72, align: 'right', value: (l: RoyaltyReportSaleLine) => money(l.salesIncTax, report.currency) },
        { label: 'Royalty', width: 60, align: 'right', value: (l: RoyaltyReportSaleLine) => money(l.royalty, report.currency) },
      ],
      rows: report.sales,
    });
  }

  // Two sheets: the Executive Summary (as the CSV and the PDF show it), and the
  // won deals it is added up from, ending in their own totals.
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

    const sheet = workbook.addWorksheet('Deals Won');
    sheet.addRow(['Deal', 'Customer', 'Closed', 'Quote #', 'Sales (Ex Tax)', 'Tax', 'Sales (Including Tax)', 'Royalty']);
    for (const l of report.sales) {
      sheet.addRow([l.dealName, l.customerName, l.date, l.quoteNumbers ?? '—', l.salesExTax, l.tax, l.salesIncTax, l.royalty]);
    }
    sheet.addRow([]);
    sheet.addRow(['Summary']);
    sheet.addRow(['Deals Won', report.salesSummary.totalRecords]);
    sheet.addRow(['Sales (Ex Tax)', report.salesSummary.totalSalesExTax]);
    sheet.addRow(['Tax', report.salesSummary.totalTax]);
    sheet.addRow(['Sales (Including Tax)', report.salesSummary.totalSalesIncTax]);
    sheet.addRow(['Royalty (before cap)', report.salesSummary.totalRoyalty]);
    for (let i = 1; i <= 8; i++) sheet.getColumn(i).width = i === 2 ? 34 : 20;

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
