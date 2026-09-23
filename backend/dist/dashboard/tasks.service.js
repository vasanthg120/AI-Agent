"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TasksService = void 0;
const common_1 = require("@nestjs/common");
const mongoose_1 = require("@nestjs/mongoose");
const mongoose_2 = require("mongoose");
const chat_service_1 = require("../chat/chat.service");
const gamification_service_1 = require("../gamification/gamification.service");
const timeline_service_1 = require("../timeline/timeline.service");
const account_schema_1 = require("../crm/schemas/account.schema");
const contact_schema_1 = require("../crm/schemas/contact.schema");
const deal_schema_1 = require("../crm/schemas/deal.schema");
const quote_schema_1 = require("../crm/schemas/quote.schema");
const email_intelligence_item_schema_1 = require("../email-intelligence/schemas/email-intelligence-item.schema");
const email_intelligence_service_1 = require("../email-intelligence/email-intelligence.service");
const agent_scope_util_1 = require("./agent-scope.util");
const task_visibility_util_1 = require("./task-visibility.util");
const daily_report_schema_1 = require("./schemas/daily-report.schema");
function todayStamp() {
    return new Date().toISOString().slice(0, 10);
}
function dayRange(date) {
    const start = new Date(`${date}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { start, end };
}
let TasksService = class TasksService {
    constructor(reportModel, dealModel, quoteModel, contactModel, accountModel, emailModel, chatService, gamificationService, timelineService) {
        this.reportModel = reportModel;
        this.dealModel = dealModel;
        this.quoteModel = quoteModel;
        this.contactModel = contactModel;
        this.accountModel = accountModel;
        this.emailModel = emailModel;
        this.chatService = chatService;
        this.gamificationService = gamificationService;
        this.timelineService = timelineService;
    }
    async list(query, caller) {
        const allowedAgentIds = await (0, agent_scope_util_1.resolveAllowedAgentIds)(this.chatService, caller);
        const from = query.dateFrom ?? todayStamp();
        const to = query.dateTo ?? query.dateFrom ?? todayStamp();
        const reports = await this.reportModel
            .find({ organizationId: caller.organizationId, agentId: { $in: allowedAgentIds }, date: { $gte: from, $lte: to } })
            .lean()
            .exec();
        const mineFilter = query.mine ?? true;
        const tasks = reports.flatMap((r) => r.tasks
            .filter((t) => !query.status || t.status === query.status)
            .filter((t) => !mineFilter || (0, task_visibility_util_1.isTaskVisibleToUser)(t, caller.sub))
            .map((t) => ({
            id: t._id.toString(),
            title: t.title,
            priority: t.priority,
            category: t.category,
            isOverdue: t.isOverdue,
            status: t.status,
            agentId: r.agentId,
            reportId: r._id.toString(),
            reportType: r.reportType,
            date: r.date,
            assignedUserId: t.assignedUserId,
        })));
        return { tasks };
    }
    async calendarSummary(month, caller, mine = true, reportType) {
        const allowedAgentIds = await (0, agent_scope_util_1.resolveAllowedAgentIds)(this.chatService, caller);
        const reports = await this.reportModel
            .find({
            organizationId: caller.organizationId,
            agentId: { $in: allowedAgentIds },
            date: { $regex: `^${month}` },
            ...(reportType ? { reportType } : {}),
        })
            .lean()
            .exec();
        const byDate = new Map();
        for (const r of reports) {
            const visibleTasks = mine ? r.tasks.filter((t) => (0, task_visibility_util_1.isTaskVisibleToUser)(t, caller.sub)) : r.tasks;
            const cur = byDate.get(r.date) ?? { reportCount: 0, taskCount: 0, hasUrgent: false };
            cur.reportCount += 1;
            cur.taskCount += visibleTasks.length;
            cur.hasUrgent = cur.hasUrgent || visibleTasks.some((t) => t.priority === 'urgent');
            byDate.set(r.date, cur);
        }
        return { month, days: [...byDate.entries()].map(([date, v]) => ({ date, ...v })) };
    }
    async getEodSummary(caller, requestedDate) {
        const date = requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : todayStamp();
        const { start, end } = dayRange(date);
        const { organizationId, sub: userId } = caller;
        const [{ tasks }, emailReceived, emailSent, emailResponded, emailPending, dealsCreated, dealsUpdated, quotesCreated, quotesUpdated, newContacts, newAccounts, eodReport] = await Promise.all([
            this.list({ dateFrom: date, dateTo: date }, caller),
            this.emailModel.countDocuments({ organizationId, userId, intent: { $in: email_intelligence_service_1.RELEVANT_EMAIL_INTENTS }, receivedAt: { $gte: start, $lt: end } }).exec(),
            this.emailModel.countDocuments({ organizationId, userId, intent: { $in: email_intelligence_service_1.RELEVANT_EMAIL_INTENTS }, sentAt: { $gte: start, $lt: end } }).exec(),
            this.emailModel
                .countDocuments({
                organizationId,
                userId,
                intent: { $in: email_intelligence_service_1.RELEVANT_EMAIL_INTENTS },
                $or: [{ sentAt: { $gte: start, $lt: end } }, { externalReplyDetectedAt: { $gte: start, $lt: end } }],
            })
                .exec(),
            this.emailModel
                .countDocuments({ organizationId, userId, intent: { $in: email_intelligence_service_1.RELEVANT_EMAIL_INTENTS }, status: 'pending', externalReplyDetectedAt: { $exists: false } })
                .exec(),
            this.dealModel.countDocuments({ organizationId, ownerId: userId, createdAt: { $gte: start, $lt: end } }).exec(),
            this.dealModel.countDocuments({ organizationId, ownerId: userId, updatedAt: { $gte: start, $lt: end } }).exec(),
            this.quoteModel.countDocuments({ organizationId, ownerUserId: userId, createdAt: { $gte: start, $lt: end } }).exec(),
            this.quoteModel.countDocuments({ organizationId, ownerUserId: userId, updatedAt: { $gte: start, $lt: end } }).exec(),
            this.contactModel.countDocuments({ organizationId, createdAt: { $gte: start, $lt: end } }).exec(),
            this.accountModel.countDocuments({ organizationId, createdAt: { $gte: start, $lt: end } }).exec(),
            this.reportModel.findOne({ organizationId, reportType: 'eod', date }).sort({ updatedAt: -1 }).lean().exec(),
        ]);
        return {
            date,
            tasksCompleted: tasks.filter((t) => t.status === 'done'),
            tasksPending: tasks.filter((t) => t.status !== 'done'),
            email: { received: emailReceived, sent: emailSent, responded: emailResponded, pending: emailPending },
            crm: { dealsCreated, dealsUpdated, quotesCreated, quotesUpdated },
            newContactsAcrossOrg: newContacts,
            newAccountsAcrossOrg: newAccounts,
            narrativeSummary: eodReport?.summary || null,
            reportExists: !!eodReport,
            reportGeneratedAt: eodReport?.updatedAt ?? null,
        };
    }
    async updateStatus(taskId, status, caller) {
        if (!mongoose_2.Types.ObjectId.isValid(taskId)) {
            throw new common_1.NotFoundException('Task not found');
        }
        const allowedAgentIds = await (0, agent_scope_util_1.resolveAllowedAgentIds)(this.chatService, caller);
        const taskObjectId = new mongoose_2.Types.ObjectId(taskId);
        const filter = {
            'tasks._id': taskObjectId,
            organizationId: caller.organizationId,
            agentId: { $in: allowedAgentIds },
        };
        const report = await this.reportModel.findOne(filter).exec();
        if (!report) {
            throw new common_1.NotFoundException('Task not found');
        }
        const task = report.tasks.find((t) => t._id.equals(taskObjectId));
        const wasAlreadyDone = task?.status === 'done';
        const wasOverdue = task?.isOverdue ?? false;
        await this.reportModel.updateOne(filter, { $set: { 'tasks.$.status': status } }).exec();
        let newAchievements = [];
        if (status === 'done' && !wasAlreadyDone) {
            const result = await this.gamificationService.recordTaskCompletion(caller.sub, caller.organizationId, wasOverdue);
            newAchievements = result.newAchievements;
            await this.timelineService
                .record({
                organizationId: caller.organizationId,
                userId: caller.sub,
                type: 'task_completed',
                title: task?.title ?? 'Task completed',
                sourceType: 'task',
                sourceId: taskId,
            })
                .catch(() => undefined);
        }
        return { id: taskId, status, newAchievements };
    }
};
exports.TasksService = TasksService;
exports.TasksService = TasksService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, mongoose_1.InjectModel)(daily_report_schema_1.DailyReport.name)),
    __param(1, (0, mongoose_1.InjectModel)(deal_schema_1.Deal.name)),
    __param(2, (0, mongoose_1.InjectModel)(quote_schema_1.Quote.name)),
    __param(3, (0, mongoose_1.InjectModel)(contact_schema_1.Contact.name)),
    __param(4, (0, mongoose_1.InjectModel)(account_schema_1.Account.name)),
    __param(5, (0, mongoose_1.InjectModel)(email_intelligence_item_schema_1.EmailIntelligenceItem.name)),
    __metadata("design:paramtypes", [mongoose_2.Model,
        mongoose_2.Model,
        mongoose_2.Model,
        mongoose_2.Model,
        mongoose_2.Model,
        mongoose_2.Model,
        chat_service_1.ChatService,
        gamification_service_1.GamificationService,
        timeline_service_1.TimelineService])
], TasksService);
//# sourceMappingURL=tasks.service.js.map