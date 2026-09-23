"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TasksExportService = void 0;
const common_1 = require("@nestjs/common");
const json2csv_1 = require("json2csv");
const branded_pdf_1 = require("../common/pdf/branded-pdf");
const STATUS_LABELS = { todo: 'To Do', in_progress: 'In Progress', done: 'Done' };
const STATUS_ORDER = ['todo', 'in_progress', 'done'];
function taskColumns() {
    return [
        { label: 'Title', width: 'auto', align: 'left', value: (t) => t.title },
        { label: 'Priority', width: 70, align: 'left', value: (t) => t.priority.toUpperCase() },
        { label: 'Category', width: 100, align: 'left', value: (t) => t.category ?? '—' },
        { label: 'Overdue', width: 60, align: 'center', value: (t) => (t.isOverdue ? 'Yes' : '—') },
    ];
}
function formatRange(dateFrom, dateTo, fallback = 'Today') {
    if (!dateFrom)
        return fallback;
    return dateTo && dateTo !== dateFrom ? `${dateFrom} – ${dateTo}` : dateFrom;
}
let TasksExportService = class TasksExportService {
    toCsv(tasks) {
        const parser = new json2csv_1.Parser({
            fields: ['title', 'priority', 'category', 'isOverdue', 'status', 'agentId', 'reportType', 'date'],
        });
        return parser.parse(tasks);
    }
    writePdf(doc, tasks, meta) {
        (0, branded_pdf_1.drawHeader)(doc, { title: 'Task Export', subtitle: formatRange(meta.dateFrom, meta.dateTo) });
        const byStatus = { todo: [], in_progress: [], done: [] };
        for (const t of tasks)
            byStatus[t.status]?.push(t);
        for (const status of STATUS_ORDER) {
            const group = byStatus[status];
            if (group.length === 0)
                continue;
            (0, branded_pdf_1.sectionHeading)(doc, `${STATUS_LABELS[status]} (${group.length})`);
            (0, branded_pdf_1.drawTable)(doc, { columns: taskColumns(), rows: group });
        }
        if (tasks.length === 0) {
            doc.fontSize(11).fillColor(branded_pdf_1.BRAND.muted).text('No tasks in this range.');
        }
    }
    toEodCsv(summary) {
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
        const parser = new json2csv_1.Parser({ fields: ['metric', 'value'] });
        return parser.parse(rows);
    }
    writeEodPdf(doc, summary) {
        (0, branded_pdf_1.drawHeader)(doc, { title: 'End of Day Report', subtitle: summary.date });
        if (summary.narrativeSummary) {
            (0, branded_pdf_1.sectionHeading)(doc, 'Summary');
            doc.fontSize(10).fillColor(branded_pdf_1.BRAND.ink).text(summary.narrativeSummary, {
                width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
            });
        }
        else if (!summary.reportExists) {
            (0, branded_pdf_1.sectionHeading)(doc, 'Summary');
            doc.fontSize(10).fillColor(branded_pdf_1.BRAND.muted).text('No EOD report has been generated for this day yet.');
        }
        (0, branded_pdf_1.sectionHeading)(doc, 'Email Activity');
        (0, branded_pdf_1.drawTable)(doc, {
            columns: [
                { label: 'Metric', width: 'auto', align: 'left', value: (r) => r.metric },
                { label: 'Value', width: 110, align: 'right', value: (r) => r.value },
            ],
            rows: [
                { metric: 'Received', value: String(summary.email.received) },
                { metric: 'Sent', value: String(summary.email.sent) },
                { metric: 'Responded to', value: String(summary.email.responded) },
                { metric: 'Still pending', value: String(summary.email.pending) },
            ],
        });
        (0, branded_pdf_1.sectionHeading)(doc, 'CRM Activity');
        (0, branded_pdf_1.drawTable)(doc, {
            columns: [
                { label: 'Metric', width: 'auto', align: 'left', value: (r) => r.metric },
                { label: 'Value', width: 110, align: 'right', value: (r) => r.value },
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
        (0, branded_pdf_1.sectionHeading)(doc, `Tasks Completed (${summary.tasksCompleted.length})`);
        if (summary.tasksCompleted.length === 0) {
            doc.fontSize(10).fillColor(branded_pdf_1.BRAND.muted).text('Nothing completed on this day.');
        }
        else {
            (0, branded_pdf_1.drawTable)(doc, { columns: taskColumns(), rows: summary.tasksCompleted });
        }
        (0, branded_pdf_1.sectionHeading)(doc, `Pending — Needs Attention (${summary.tasksPending.length})`);
        if (summary.tasksPending.length === 0) {
            doc.fontSize(10).fillColor(branded_pdf_1.BRAND.muted).text('Nothing pending on this day.');
        }
        else {
            (0, branded_pdf_1.drawTable)(doc, { columns: taskColumns(), rows: summary.tasksPending });
        }
    }
};
exports.TasksExportService = TasksExportService;
exports.TasksExportService = TasksExportService = __decorate([
    (0, common_1.Injectable)()
], TasksExportService);
//# sourceMappingURL=tasks-export.service.js.map