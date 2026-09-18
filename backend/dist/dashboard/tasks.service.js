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
const axios_1 = require("@nestjs/axios");
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const jwt_1 = require("@nestjs/jwt");
const mongoose_1 = require("@nestjs/mongoose");
const rxjs_1 = require("rxjs");
const mongoose_2 = require("mongoose");
const chat_service_1 = require("../chat/chat.service");
const gamification_service_1 = require("../gamification/gamification.service");
const timeline_service_1 = require("../timeline/timeline.service");
const agent_scope_util_1 = require("./agent-scope.util");
const task_visibility_util_1 = require("./task-visibility.util");
const daily_report_schema_1 = require("./schemas/daily-report.schema");
function todayStamp() {
    return new Date().toISOString().slice(0, 10);
}
let TasksService = class TasksService {
    constructor(reportModel, chatService, http, config, jwt, gamificationService, timelineService) {
        this.reportModel = reportModel;
        this.chatService = chatService;
        this.http = http;
        this.config = config;
        this.jwt = jwt;
        this.gamificationService = gamificationService;
        this.timelineService = timelineService;
        this.agentUrl = this.config.get('pythonAgentUrl') ?? 'http://localhost:8000';
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
    async calendarSummary(month, caller, mine = true) {
        const allowedAgentIds = await (0, agent_scope_util_1.resolveAllowedAgentIds)(this.chatService, caller);
        const reports = await this.reportModel
            .find({ organizationId: caller.organizationId, agentId: { $in: allowedAgentIds }, date: { $regex: `^${month}` } })
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
    async getRecommendations(caller) {
        const { tasks } = await this.list({}, caller);
        const openTasks = tasks.filter((t) => t.status !== 'done');
        if (openTasks.length === 0) {
            return { recommendations: [], overallNote: 'Nothing open right now.' };
        }
        const userJwt = this.jwt.sign({ sub: caller.sub }, { expiresIn: '5m' });
        const { data } = await (0, rxjs_1.firstValueFrom)(this.http.post(`${this.agentUrl}/tasks/recommend`, { tasks: openTasks.map((t) => ({ id: t.id, title: t.title, priority: t.priority, isOverdue: t.isOverdue, category: t.category })) }, { headers: { Authorization: `Bearer ${userJwt}` } }));
        const byId = new Map(openTasks.map((t) => [t.id, t]));
        const recommendations = data.recommendations
            .filter((r) => byId.has(r.taskId))
            .map((r) => ({ ...r, task: byId.get(r.taskId) }));
        return { recommendations, overallNote: data.overallNote };
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
    __metadata("design:paramtypes", [mongoose_2.Model,
        chat_service_1.ChatService,
        axios_1.HttpService,
        config_1.ConfigService,
        jwt_1.JwtService,
        gamification_service_1.GamificationService,
        timeline_service_1.TimelineService])
], TasksService);
//# sourceMappingURL=tasks.service.js.map