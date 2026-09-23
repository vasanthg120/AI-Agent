import { Injectable } from '@nestjs/common';
import { Parser } from 'json2csv';
import ExcelJS from 'exceljs';
import { BRAND, drawHeader, drawTable } from '../common/pdf/branded-pdf';
import { EmailIntelligenceItemDocument } from '../email-intelligence/schemas/email-intelligence-item.schema';

export interface BiEmailExportRow {
  subject: string;
  fromAddress: string;
  employeeName: string;
  intent: string;
  priority: string;
  status: string;
  receivedAt: string;
  sentAt?: string;
  matchedBusinessName?: string;
}

// Mirrors deals-export.service.ts's structure exactly (json2csv/pdfkit/
// exceljs, no embedded charts) — same export convention every list-with-export
// controller in this app follows.
@Injectable()
export class EmailAnalyticsExportService {
  buildRows(items: EmailIntelligenceItemDocument[], employeeNameById: Map<string, string>): BiEmailExportRow[] {
    return items.map((i) => ({
      subject: i.subject || '(no subject)',
      fromAddress: i.fromAddress,
      employeeName: employeeNameById.get(i.userId) ?? 'Unknown user',
      intent: i.intent,
      priority: i.priority,
      status: i.status,
      receivedAt: i.receivedAt.toISOString(),
      sentAt: i.sentAt?.toISOString(),
      matchedBusinessName: i.matchedBusinessName,
    }));
  }

  toCsv(rows: BiEmailExportRow[]): string {
    const parser = new Parser({
      fields: ['subject', 'fromAddress', 'employeeName', 'intent', 'priority', 'status', 'receivedAt', 'sentAt', 'matchedBusinessName'],
    });
    return parser.parse(rows);
  }

  writePdf(doc: PDFKit.PDFDocument, rows: BiEmailExportRow[], meta: { dateFrom?: string; dateTo?: string }): void {
    const range = meta.dateFrom
      ? meta.dateTo && meta.dateTo !== meta.dateFrom
        ? `${meta.dateFrom} – ${meta.dateTo}`
        : meta.dateFrom
      : 'Current month';
    drawHeader(doc, { title: 'Email Analytics Export', subtitle: range });

    if (rows.length === 0) {
      doc.fontSize(11).fillColor(BRAND.muted).text('No emails match the current filters.');
      return;
    }

    drawTable(doc, {
      columns: [
        { label: 'Subject', width: 'auto', align: 'left', value: (r) => r.subject },
        { label: 'From', width: 120, align: 'left', value: (r) => r.fromAddress },
        { label: 'Employee', width: 100, align: 'left', value: (r) => r.employeeName },
        { label: 'Intent', width: 70, align: 'left', value: (r) => r.intent },
        { label: 'Status', width: 60, align: 'left', value: (r) => r.status },
      ],
      rows,
    });
  }

  async toExcel(rows: BiEmailExportRow[]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Emails');

    const headers = ['Subject', 'From', 'Employee', 'Intent', 'Priority', 'Status', 'Received At', 'Sent At', 'Matched Business'];
    sheet.addRow(headers);
    for (const r of rows) {
      sheet.addRow([r.subject, r.fromAddress, r.employeeName, r.intent, r.priority, r.status, r.receivedAt, r.sentAt ?? '', r.matchedBusinessName ?? '']);
    }
    for (let i = 1; i <= headers.length; i++) {
      sheet.getColumn(i).width = 20;
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
