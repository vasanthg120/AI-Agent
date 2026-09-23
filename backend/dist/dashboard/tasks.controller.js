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
exports.TasksController = void 0;
const common_1 = require("@nestjs/common");
const branded_pdf_1 = require("../common/pdf/branded-pdf");
const jwt_auth_guard_1 = require("../common/guards/jwt-auth.guard");
const current_user_decorator_1 = require("../common/decorators/current-user.decorator");
const export_tasks_query_dto_1 = require("./dto/export-tasks-query.dto");
const list_tasks_query_dto_1 = require("./dto/list-tasks-query.dto");
const update_task_status_dto_1 = require("./dto/update-task-status.dto");
const tasks_export_service_1 = require("./tasks-export.service");
const tasks_service_1 = require("./tasks.service");
let TasksController = class TasksController {
    constructor(tasksService, tasksExportService) {
        this.tasksService = tasksService;
        this.tasksExportService = tasksExportService;
    }
    list(query, user) {
        return this.tasksService.list(query, user);
    }
    calendar(month, mine, reportType, user) {
        return this.tasksService.calendarSummary(month, user, mine === undefined ? undefined : mine === 'true', reportType === 'morning' || reportType === 'eod' ? reportType : undefined);
    }
    eodSummary(date, user) {
        return this.tasksService.getEodSummary(user, date);
    }
    async export(query, user, res) {
        const { tasks } = await this.tasksService.list(query, user);
        const filenameDate = query.dateFrom ?? 'today';
        if (query.format === 'csv') {
            res.set({
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="tasks-${filenameDate}.csv"`,
            });
            res.send(this.tasksExportService.toCsv(tasks));
            return;
        }
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="tasks-${filenameDate}.pdf"`,
        });
        const doc = (0, branded_pdf_1.createBrandedDocument)();
        doc.pipe(res);
        this.tasksExportService.writePdf(doc, tasks, query);
        (0, branded_pdf_1.finalizePagedDocument)(doc);
    }
    async eodExport(date, format, user, res) {
        const summary = await this.tasksService.getEodSummary(user, date);
        const filenameDate = summary.date;
        if (format === 'csv') {
            res.set({
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="eod-${filenameDate}.csv"`,
            });
            res.send(this.tasksExportService.toEodCsv(summary));
            return;
        }
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="eod-${filenameDate}.pdf"`,
        });
        const doc = (0, branded_pdf_1.createBrandedDocument)();
        doc.pipe(res);
        this.tasksExportService.writeEodPdf(doc, summary);
        (0, branded_pdf_1.finalizePagedDocument)(doc);
    }
    updateStatus(id, dto, user) {
        return this.tasksService.updateStatus(id, dto.status, user);
    }
};
exports.TasksController = TasksController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, common_1.Query)()),
    __param(1, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [list_tasks_query_dto_1.ListTasksQueryDto, Object]),
    __metadata("design:returntype", void 0)
], TasksController.prototype, "list", null);
__decorate([
    (0, common_1.Get)('calendar'),
    __param(0, (0, common_1.Query)('month')),
    __param(1, (0, common_1.Query)('mine')),
    __param(2, (0, common_1.Query)('reportType')),
    __param(3, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Object]),
    __metadata("design:returntype", void 0)
], TasksController.prototype, "calendar", null);
__decorate([
    (0, common_1.Get)('eod'),
    __param(0, (0, common_1.Query)('date')),
    __param(1, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], TasksController.prototype, "eodSummary", null);
__decorate([
    (0, common_1.Get)('export'),
    __param(0, (0, common_1.Query)()),
    __param(1, (0, current_user_decorator_1.CurrentUser)()),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [export_tasks_query_dto_1.ExportTasksQueryDto, Object, Object]),
    __metadata("design:returntype", Promise)
], TasksController.prototype, "export", null);
__decorate([
    (0, common_1.Get)('eod/export'),
    __param(0, (0, common_1.Query)('date')),
    __param(1, (0, common_1.Query)('format')),
    __param(2, (0, current_user_decorator_1.CurrentUser)()),
    __param(3, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object, Object]),
    __metadata("design:returntype", Promise)
], TasksController.prototype, "eodExport", null);
__decorate([
    (0, common_1.Patch)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, update_task_status_dto_1.UpdateTaskStatusDto, Object]),
    __metadata("design:returntype", void 0)
], TasksController.prototype, "updateStatus", null);
exports.TasksController = TasksController = __decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Controller)('tasks'),
    __metadata("design:paramtypes", [tasks_service_1.TasksService,
        tasks_export_service_1.TasksExportService])
], TasksController);
//# sourceMappingURL=tasks.controller.js.map