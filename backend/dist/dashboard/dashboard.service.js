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
exports.DashboardService = void 0;
const crypto_1 = require("crypto");
const axios_1 = require("@nestjs/axios");
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const jwt_1 = require("@nestjs/jwt");
const mongoose_1 = require("@nestjs/mongoose");
const mongoose_2 = require("mongoose");
const rxjs_1 = require("rxjs");
const reservation_service_1 = require("../billing/reservation.service");
const chat_service_1 = require("../chat/chat.service");
const agent_scope_util_1 = require("./agent-scope.util");
const daily_report_schema_1 = require("./schemas/daily-report.schema");
function todayStamp() {
    return new Date().toISOString().slice(0, 10);
}
let DashboardService = class DashboardService {
    constructor(reportModel, http, config, jwt, chatService, reservations) {
        this.reportModel = reportModel;
        this.http = http;
        this.config = config;
        this.jwt = jwt;
        this.chatService = chatService;
        this.reservations = reservations;
        this.agentUrl = this.config.get('pythonAgentUrl') ?? 'http://localhost:8000';
    }
    async recordDailyReport(input) {
        const requestId = (0, crypto_1.randomUUID)();
        await this.reservations.reserve(input.organizationId, input.userId, requestId, 'scheduled-report');
        const userJwt = this.jwt.sign({ sub: input.userId, organizationId: input.organizationId }, { expiresIn: '5m' });
        let data;
        try {
            const response = await (0, rxjs_1.firstValueFrom)(this.http.post(`${this.agentUrl}/reports/generate`, { report_type: input.reportType, request_id: requestId }, { headers: { Authorization: `Bearer ${userJwt}` } }));
            data = response.data;
            await this.reservations.settle(requestId);
        }
        catch (err) {
            await this.reservations.release(requestId);
            throw err;
        }
        return this.reportModel
            .findOneAndUpdate({
            organizationId: input.organizationId,
            storeId: input.storeId,
            agentId: input.agentId,
            reportType: input.reportType,
            date: input.date,
        }, {
            tasks: data.tasks,
            summary: data.summary,
            sourceConversationId: input.conversationId,
            sourceUserId: input.userId,
            wasMissed: input.wasMissed ?? false,
        }, { upsert: true, new: true })
            .exec();
    }
    async hasReportToday(organizationId, storeId, reportType, date) {
        const count = await this.reportModel.countDocuments({ organizationId, storeId, reportType, date }).exec();
        return count > 0;
    }
    async getOverview(caller, agentId) {
        const date = todayStamp();
        const [allReports, agents] = await Promise.all([
            caller?.organizationId
                ? this.reportModel.find({ organizationId: caller.organizationId, date }).sort({ updatedAt: -1 }).lean().exec()
                : Promise.resolve([]),
            this.chatService.listAgents(caller),
        ]);
        let scopedAgentIds = new Set(agents.map((a) => a.id));
        if (agentId) {
            if (!scopedAgentIds.has(agentId)) {
                throw new common_1.NotFoundException('Agent not found');
            }
            scopedAgentIds = new Set([agentId]);
        }
        const reports = allReports.filter((r) => scopedAgentIds.has(r.agentId));
        const scopedAgents = agents.filter((a) => scopedAgentIds.has(a.id));
        const byAgent = new Map();
        for (const r of reports) {
            byAgent.set(r.agentId, [...(byAgent.get(r.agentId) ?? []), r]);
        }
        const agentsOut = scopedAgents.map((a) => {
            const own = byAgent.get(a.id) ?? [];
            const latest = own.find((r) => r.reportType === 'eod') ?? own.find((r) => r.reportType === 'morning');
            return {
                id: a.id,
                name: a.name,
                avatarColor: a.avatarColor,
                status: latest ? 'reported' : 'pending',
                todaysTaskCount: own.reduce((n, r) => n + r.tasks.length, 0),
                lastReportType: latest?.reportType,
                lastReportAt: latest?.updatedAt,
            };
        });
        const allTasks = reports.flatMap((r) => r.tasks.map((t) => ({ ...t, agentId: r.agentId, reportId: r._id.toString() })));
        const urgentCount = allTasks.filter((t) => t.priority === 'urgent').length;
        const overdueCount = allTasks.filter((t) => t.isOverdue).length;
        const totalTasks = allTasks.length;
        return {
            date,
            agents: agentsOut,
            stats: {
                totalTasks,
                urgentCount,
                overdueCount,
                reportsGenerated: reports.length,
                followUpHealthPct: totalTasks === 0 ? null : Math.round((1 - overdueCount / totalTasks) * 100),
            },
            criticalAlerts: allTasks.filter((t) => t.priority === 'urgent' || t.isOverdue).slice(0, 20),
            recentReports: reports.map((r) => ({
                id: r._id.toString(),
                agentId: r.agentId,
                reportType: r.reportType,
                summary: r.summary,
                taskCount: r.tasks.length,
                sourceConversationId: r.sourceConversationId,
                createdAt: r.createdAt,
            })),
        };
    }
    async getTrend(agentId, days, caller) {
        if (!caller?.organizationId) {
            throw new common_1.NotFoundException('Agent not found');
        }
        const allowedAgentIds = await (0, agent_scope_util_1.resolveAllowedAgentIds)(this.chatService, caller);
        if (!allowedAgentIds.includes(agentId)) {
            throw new common_1.NotFoundException('Agent not found');
        }
        const dates = [];
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date();
            d.setUTCDate(d.getUTCDate() - i);
            dates.push(d.toISOString().slice(0, 10));
        }
        const reports = await this.reportModel
            .find({
            organizationId: caller.organizationId,
            agentId,
            date: { $gte: dates[0], $lte: dates[dates.length - 1] },
        })
            .lean()
            .exec();
        const byDate = new Map();
        for (const r of reports) {
            const cur = byDate.get(r.date) ?? { totalTasks: 0, urgentCount: 0, overdueCount: 0 };
            cur.totalTasks += r.tasks.length;
            cur.urgentCount += r.tasks.filter((t) => t.priority === 'urgent').length;
            cur.overdueCount += r.tasks.filter((t) => t.isOverdue).length;
            byDate.set(r.date, cur);
        }
        const points = dates.map((date) => {
            const v = byDate.get(date) ?? { totalTasks: 0, urgentCount: 0, overdueCount: 0 };
            return {
                date,
                ...v,
                followUpHealthPct: v.totalTasks === 0 ? null : Math.round((1 - v.overdueCount / v.totalTasks) * 100),
            };
        });
        return { agentId, days, points };
    }
};
exports.DashboardService = DashboardService;
exports.DashboardService = DashboardService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, mongoose_1.InjectModel)(daily_report_schema_1.DailyReport.name)),
    __metadata("design:paramtypes", [mongoose_2.Model,
        axios_1.HttpService,
        config_1.ConfigService,
        jwt_1.JwtService,
        chat_service_1.ChatService,
        reservation_service_1.ReservationService])
], DashboardService);
//# sourceMappingURL=dashboard.service.js.map