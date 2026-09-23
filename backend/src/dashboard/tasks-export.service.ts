import { Injectable } from '@nestjs/common';
import { Parser } from 'json2csv';
import { BRAND, drawHeader, drawTable, sectionHeading } from '../common/pdf/branded-pdf';
import { EodSummary, TaskOut } from './tasks.service';

const STATUS_LABELS: Record<string, string> = { todo: 'To Do', in_progress: 'In Progress', done: 'Done' };
const STATUS_ORDER = ['todo', 'in_progress', 'done'] as const;

function taskColumns() {
  return [
    { label: 'Title', width: 'auto' as const, align: 'left' as const, value: (t: TaskOut) => t.title },
    { label: 'Priority', width: 70, align: 'left' as const, value: (t: TaskOut) => t.priority.toUpperCase() },
    { label: 'Category', width: 100, align: 'left' as const, value: (t: TaskOut) => t.category ?? '—' },
    { label: 'Overdue', width: 60, align: 'center' as const, value: (t: TaskOut) => (t.isOverdue ? 'Yes' : '—') },
  ];
}

function formatRange(dateFrom?: string, dateTo?: string, fallback = 'Today'): string {
  if (!dateFrom) return fallback;
  return dateTo && dateTo !== dateFrom ? `${dateFrom} – ${dateTo}` : dateFrom;
}

@Injectable()
export class TasksExportService {
  toCsv(tasks: TaskOut[]): string {
    const parser = new Parser({
      fields: ['title', 'priority', 'category', 'isOverdue', 'status', 'agentId', 'reportType', 'date'],
    });
    return parser.parse(tasks);
  }

  writePdf(doc: PDFKit.PDFDocument, tasks: TaskOut[], meta: { dateFrom?: string; dateTo?: string }): void {
    drawHeader(doc, { title: 'Task Export', subtitle: formatRange(meta.dateFrom, meta.dateTo) });

    const byStatus: Record<string, TaskOut[]> = { todo: [], in_progress: [], done: [] };
    for (const t of tasks) byStatus[t.status]?.push(t);

    for (const status of STATUS_ORDER) {
      const group = byStatus[status];
      if (group.length === 0) continue;
      sectionHeading(doc, `${STATUS_LABELS[status]} (${group.length})`);
      drawTable(doc, { columns: taskColumns(), rows: group });
    }

    if (tasks.length === 0) {
      doc.fontSize(11).fillColor(BRAND.muted).text('No tasks in this range.');
    }
  }

  toEodCsv(summary: EodSummary): string {
    const rows = [
      { metric: 'Date', value: summary.date },
      { metric: 'Report Generated', value: summary.reportExists ? 'Yes' : 'No' },
      { metric: 'Tasks Completed', value: String(summary.tasksCompleted.length) },
      { metric: 'Tasks Pending', value: String(summary.tasksPending.length) },
      { metric: 'Emails Received', value: String(summary.email.received) },
      { metric: 'Emails Sent', value: String(summary.email.sent) },
      { metric: 'Emails Responded', value: String(summary.email.responded) },
      { metric: 'Emails Pending', value: String(summary.email.pending) },
      { metric: 'Deals Created', value: String(summary.crm.dealsCreated) },
      { metric: 'Deals Updated', value: String(summary.crm.dealsUpdated) },
      { metric: 'Quotes Created', value: String(summary.crm.quotesCreated) },
      { metric: 'Quotes Updated', value: String(summary.crm.quotesUpdated) },
      { metric: 'New Contacts (org-wide)', value: String(summary.newContactsAcrossOrg) },
      { metric: 'New Accounts (org-wide)', value: String(summary.newAccountsAcrossOrg) },
    ];
    const parser = new Parser({ fields: ['metric', 'value'] });
    return parser.parse(rows);
  }

  // A real EOD report — narrative, real stats, and the same task tables the
  // board itself shows — replacing what used to be a re-export of that
  // day's task list (see tasks.controller.ts's own comment on why the old
  // /tasks/export route was never actually an EOD report).
  writeEodPdf(doc: PDFKit.PDFDocument, summary: EodSummary): void {
    drawHeader(doc, { title: 'End of Day Report', subtitle: summary.date });

    if (summary.narrativeSummary) {
      sectionHeading(doc, 'Summary');
      doc.fontSize(10).fillColor(BRAND.ink).text(summary.narrativeSummary, {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      });
    } else if (!summary.reportExists) {
      sectionHeading(doc, 'Summary');
      doc.fontSize(10).fillColor(BRAND.muted).text('No EOD report has been generated for this day yet.');
    }

    sectionHeading(doc, 'Email Activity');
    drawTable(doc, {
      columns: [
        { label: 'Metric', width: 'auto', align: 'left', value: (r: { metric: string; value: string }) => r.metric },
        { label: 'Value', width: 110, align: 'right', value: (r: { metric: string; value: string }) => r.value },
      ],
      rows: [
        { metric: 'Received', value: String(summary.email.received) },
        { metric: 'Sent', value: String(summary.email.sent) },
        { metric: 'Responded to', value: String(summary.email.responded) },
        { metric: 'Still pending', value: String(summary.email.pending) },
      ],
    });

    sectionHeading(doc, 'CRM Activity');
    drawTable(doc, {
      columns: [
        { label: 'Metric', width: 'auto', align: 'left', value: (r: { metric: string; value: string }) => r.metric },
        { label: 'Value', width: 110, align: 'right', value: (r: { metric: string; value: string }) => r.value },
      ],
      rows: [
        { metric: 'Deals created', value: String(summary.crm.dealsCreated) },
        { metric: 'Deals updated', value: String(summary.crm.dealsUpdated) },
        { metric: 'Quotes created', value: String(summary.crm.quotesCreated) },
        { metric: 'Quotes updated', value: String(summary.crm.quotesUpdated) },
        { metric: 'New contacts (org-wide)', value: String(summary.newContactsAcrossOrg) },
        { metric: 'New accounts (org-wide)', value: String(summary.newAccountsAcrossOrg) },
      ],
    });

    sectionHeading(doc, `Tasks Completed (${summary.tasksCompleted.length})`);
    if (summary.tasksCompleted.length === 0) {
      doc.fontSize(10).fillColor(BRAND.muted).text('Nothing completed on this day.');
    } else {
      drawTable(doc, { columns: taskColumns(), rows: summary.tasksCompleted });
    }

    sectionHeading(doc, `Pending — Needs Attention (${summary.tasksPending.length})`);
    if (summary.tasksPending.length === 0) {
      doc.fontSize(10).fillColor(BRAND.muted).text('Nothing pending on this day.');
    } else {
      drawTable(doc, { columns: taskColumns(), rows: summary.tasksPending });
    }
  }
}
