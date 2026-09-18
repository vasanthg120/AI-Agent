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
var StoreSettingsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.StoreSettingsService = void 0;
exports.todayStamp = todayStamp;
const common_1 = require("@nestjs/common");
const schedule_1 = require("@nestjs/schedule");
const chat_service_1 = require("../chat/chat.service");
const dashboard_service_1 = require("../dashboard/dashboard.service");
const task_visibility_util_1 = require("../dashboard/task-visibility.util");
const mail_service_1 = require("../mail/mail.service");
const notifications_service_1 = require("../notifications/notifications.service");
const timeline_service_1 = require("../timeline/timeline.service");
const organizations_service_1 = require("../organizations/organizations.service");
const users_service_1 = require("../users/users.service");
const MORNING_AGENT_ID = 'store_manager';
const MORNING_PROMPT = "Generate today's to-do list: analyze CRM and Outlook, identify new enquiries and any that haven't received a follow-up, and list concrete priorities for today.";
const EOD_AGENT_ID = 'store_manager';
const EOD_PROMPT = 'Generate an end-of-day report: summarize what was completed today, outstanding follow-ups, and anything that needs attention tomorrow.';
function toMinutes(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
}
function todayStamp(tz) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function nowMinutesInZone(tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    return hour * 60 + minute;
}
function scheduledInstant(tz, hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    const todayParts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date())
        .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
    return new Date(`${todayParts.year}-${todayParts.month}-${todayParts.day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`);
}
let StoreSettingsService = StoreSettingsService_1 = class StoreSettingsService {
    constructor(organizationsService, chatService, dashboardService, usersService, notificationsService, timelineService, mailService) {
        this.organizationsService = organizationsService;
        this.chatService = chatService;
        this.dashboardService = dashboardService;
        this.usersService = usersService;
        this.notificationsService = notificationsService;
        this.timelineService = timelineService;
        this.mailService = mailService;
        this.logger = new common_1.Logger(StoreSettingsService_1.name);
    }
    getSettings(caller) {
        return this.organizationsService.resolveStoreForUser(caller.organizationId, caller.storeId);
    }
    updateSettings(caller, patch) {
        return this.organizationsService.updateStoreSettings(caller.organizationId, caller.storeId, patch);
    }
    async runNow(caller, type) {
        const store = await this.organizationsService.resolveStoreForUser(caller.organizationId, caller.storeId);
        const now = new Date().toLocaleDateString();
        const date = todayStamp(store.timezone);
        if (type === 'eod') {
            return this.runForStore(store, EOD_AGENT_ID, 'eod', EOD_PROMPT, `EOD report — ${now}`, false, date);
        }
        return this.runForStore(store, MORNING_AGENT_ID, 'morning', MORNING_PROMPT, `Morning to-do — ${now}`, false, date);
    }
    async checkAndRunDailyJobs() {
        const stores = await this.organizationsService.listAllStores();
        const now = new Date();
        for (const store of stores) {
            const today = todayStamp(store.timezone);
            const nowMin = nowMinutesInZone(store.timezone);
            const openMin = toMinutes(store.openingTime);
            if (nowMin >= openMin - 30 && store.lastMorningRunDate !== today) {
                const claimed = await this.organizationsService.claimMorningRun(store._id.toString(), today);
                if (claimed) {
                    const wasMissed = nowMin > openMin;
                    await this.runForStore(store, MORNING_AGENT_ID, 'morning', MORNING_PROMPT, `Morning to-do — ${now.toLocaleDateString()}`, wasMissed, today);
                }
            }
            const closeMin = toMinutes(store.closingTime);
            if (nowMin >= closeMin - 30 && store.lastEodRunDate !== today) {
                const claimed = await this.organizationsService.claimEodRun(store._id.toString(), today);
                if (claimed) {
                    const wasMissed = nowMin > closeMin;
                    await this.runForStore(store, EOD_AGENT_ID, 'eod', EOD_PROMPT, `EOD report — ${now.toLocaleDateString()}`, wasMissed, today);
                }
            }
        }
    }
    async runForStore(store, agentId, reportType, promptText, title, wasMissed, date) {
        const organizationId = store.organizationId;
        const storeId = store._id.toString();
        const userIds = await this.usersService.findIdsByOrgAndStore(organizationId, storeId);
        const settled = await Promise.allSettled(userIds.map((userId) => this.chatService.generateSystemConversation(userId, organizationId, agentId, promptText, title)));
        settled.forEach((r, i) => {
            if (r.status === 'rejected') {
                this.logger.error(`Scheduled report failed for user ${userIds[i]}: ${r.reason.message}`);
            }
        });
        const successes = settled
            .map((r, i) => ({ r, userId: userIds[i] }))
            .filter((x) => x.r.status === 'fulfilled')
            .map((x) => ({ value: x.r.value, userId: x.userId }));
        if (successes.length > 0) {
            const chosen = successes[0];
            const savedReport = await this.dashboardService
                .recordDailyReport({
                organizationId,
                storeId,
                agentId,
                reportType,
                date,
                conversationId: chosen.value.conversationId,
                userId: chosen.userId,
                wasMissed,
                userIds,
            })
                .catch((err) => {
                this.logger.error(`Failed to generate ${reportType} report: ${err.message}`);
                return null;
            });
            if (savedReport && reportType === 'eod') {
                await this.sendEodEmail(savedReport, store, userIds);
            }
            const occurredAt = wasMissed ? scheduledInstant(store.timezone, reportType === 'morning' ? store.openingTime : store.closingTime) : new Date();
            await this.timelineService
                .record({
                organizationId,
                storeId,
                type: wasMissed ? 'daily_report_missed' : 'daily_report_generated',
                title: wasMissed ? `${title} (generated late)` : title,
                sourceType: 'daily_report',
                occurredAt,
            })
                .catch((err) => this.logger.error(`Failed to record timeline event: ${err.message}`));
            if (wasMissed) {
                await Promise.allSettled(userIds.map((userId) => this.notificationsService.create(userId, {
                    kind: 'warning',
                    title: `${reportType === 'morning' ? 'Morning briefing' : 'EOD report'} generated late`,
                    description: `${store.name}'s scheduled ${reportType} report ran later than its usual trigger window today.`,
                    source: 'store-settings',
                }, organizationId)));
            }
        }
        return { usersNotified: successes.length, totalUsers: userIds.length };
    }
    async sendEodEmail(report, store, userIds) {
        if (report.emailStatus === 'sent')
            return;
        const recipients = (await Promise.all(userIds.map(async (userId) => {
            const email = await this.notificationsService.resolveEmailRecipient(userId, store.organizationId);
            return email ? { userId, email } : null;
        }))).filter((r) => !!r);
        if (recipients.length === 0) {
            return;
        }
        try {
            const results = await Promise.all(recipients.map(({ userId, email }) => {
                const ownTasks = report.tasks.filter((t) => (0, task_visibility_util_1.isTaskVisibleToUser)(t, userId));
                return this.mailService.sendDailyReportEmail(email, store.name, report.reportType, report.date, ownTasks, report.summary);
            }));
            const anySent = results.some(Boolean);
            await this.dashboardService.markReportEmailStatus(report._id.toString(), anySent ? 'sent' : 'failed', anySent ? undefined : 'All recipient sends failed');
        }
        catch (err) {
            this.logger.error(`EOD email dispatch failed for report ${report._id.toString()}: ${err.message}`);
            await this.dashboardService
                .markReportEmailStatus(report._id.toString(), 'failed', err.message)
                .catch(() => undefined);
        }
    }
};
exports.StoreSettingsService = StoreSettingsService;
__decorate([
    (0, schedule_1.Cron)(schedule_1.CronExpression.EVERY_10_MINUTES),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], StoreSettingsService.prototype, "checkAndRunDailyJobs", null);
exports.StoreSettingsService = StoreSettingsService = StoreSettingsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [organizations_service_1.OrganizationsService,
        chat_service_1.ChatService,
        dashboard_service_1.DashboardService,
        users_service_1.UsersService,
        notifications_service_1.NotificationsService,
        timeline_service_1.TimelineService,
        mail_service_1.MailService])
], StoreSettingsService);
//# sourceMappingURL=store-settings.service.js.map