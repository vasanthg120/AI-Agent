import { Injectable } from '@nestjs/common';
import { Parser } from 'json2csv';
import ExcelJS from 'exceljs';
import { BRAND, drawHeader, drawTable, sectionHeading } from '../common/pdf/branded-pdf';
import { FinanceDocumentDocument } from './schemas/finance-document.schema';

export interface FinanceExportRow {
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  paymentAmount: number;
  currency: string;
  paymentStatus: string;
  department: string;
  costCenter: string;
  expenseCategory: string;
  paymentMethod: string;
}

const STATUS_ORDER = ['pending', 'overdue', 'partially_paid', 'paid', 'cancelled'] as const;
const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  overdue: 'Overdue',
  partially_paid: 'Partially Paid',
  paid: 'Paid',
  cancelled: 'Cancelled',
};

function formatRange(dateFrom?: string, dateTo?: string): string {
  if (!dateFrom) return 'All time';
  return dateTo && dateTo !== dateFrom ? `${dateFrom} – ${dateTo}` : dateFrom;
}

// Mirrors crm/deals-export.service.ts's structure exactly (json2csv for
// CSV, pdfkit for PDF via the shared branded-pdf helpers, exceljs for
// Excel) — no new export pattern needed.
@Injectable()
export class FinanceExportService {
  buildRows(docs: FinanceDocumentDocument[]): FinanceExportRow[] {
    return docs.map((d) => ({
      vendorName: d.vendorName ?? 'Unknown vendor',
      invoiceNumber: d.invoiceNumber ?? '',
      invoiceDate: d.invoiceDate ?? '',
      dueDate: d.dueDate ?? '',
      paymentAmount: d.paymentAmount,
      currency: d.currency,
      paymentStatus: d.paymentStatus,
      department: d.department ?? '',
      costCenter: d.costCenter ?? '',
      expenseCategory: d.expenseCategory ?? '',
      paymentMethod: d.paymentMethod ?? '',
    }));
  }

  toCsv(rows: FinanceExportRow[]): string {
    const parser = new Parser({
      fields: [
        'vendorName',
        'invoiceNumber',
        'invoiceDate',
        'dueDate',
        'paymentAmount',
        'currency',
        'paymentStatus',
        'department',
        'costCenter',
        'expenseCategory',
        'paymentMethod',
      ],
    });
    return parser.parse(rows);
  }

  writePdf(doc: PDFKit.PDFDocument, rows: FinanceExportRow[], meta: { dateFrom?: string; dateTo?: string }): void {
    drawHeader(doc, { title: 'Finance Document Export', subtitle: formatRange(meta.dateFrom, meta.dateTo) });

    const byStatus: Record<string, FinanceExportRow[]> = { pending: [], overdue: [], partially_paid: [], paid: [], cancelled: [] };
    for (const r of rows) byStatus[r.paymentStatus]?.push(r);

    for (const status of STATUS_ORDER) {
      const group = byStatus[status];
      if (group.length === 0) continue;
      const value = group.reduce((sum, r) => sum + r.paymentAmount, 0);
      sectionHeading(doc, `${STATUS_LABELS[status]} (${group.length}) — ${value.toLocaleString()}`);
      drawTable(doc, {
        columns: [
          { label: 'Vendor', width: 'auto', align: 'left', value: (r) => r.vendorName },
          { label: 'Invoice #', width: 80, align: 'left', value: (r) => r.invoiceNumber || '—' },
          { label: 'Amount', width: 85, align: 'right', value: (r) => `${r.paymentAmount.toLocaleString()} ${r.currency}` },
          { label: 'Due Date', width: 70, align: 'left', value: (r) => r.dueDate || '—' },
          { label: 'Department', width: 90, align: 'left', value: (r) => r.department || '—' },
        ],
        rows: group,
      });
    }

    if (rows.length === 0) {
      doc.fontSize(11).fillColor(BRAND.muted).text('No finance documents match the current filters.');
    }
  }

  async toExcel(rows: FinanceExportRow[]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Finance Documents');

    const totalByStatus = new Map<string, number>();
    for (const r of rows) totalByStatus.set(r.paymentStatus, (totalByStatus.get(r.paymentStatus) ?? 0) + r.paymentAmount);
    for (const status of STATUS_ORDER) {
      sheet.addRow([STATUS_LABELS[status], totalByStatus.get(status) ?? 0]);
    }
    sheet.addRow([]);

    const headers = ['Vendor', 'Invoice #', 'Invoice Date', 'Due Date', 'Amount', 'Currency', 'Status', 'Department', 'Cost Center', 'Category', 'Payment Method'];
    sheet.addRow(headers);
    for (const r of rows) {
      sheet.addRow([
        r.vendorName,
        r.invoiceNumber,
        r.invoiceDate,
        r.dueDate,
        r.paymentAmount,
        r.currency,
        STATUS_LABELS[r.paymentStatus] ?? r.paymentStatus,
        r.department,
        r.costCenter,
        r.expenseCategory,
        r.paymentMethod,
      ]);
    }
    for (let i = 1; i <= headers.length; i++) {
      sheet.getColumn(i).width = 18;
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
