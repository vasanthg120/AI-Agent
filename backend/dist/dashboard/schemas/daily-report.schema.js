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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DailyReportSchema = exports.DailyReport = exports.DailyReportTask = void 0;
const mongoose_1 = require("@nestjs/mongoose");
let DailyReportTask = class DailyReportTask {
};
exports.DailyReportTask = DailyReportTask;
__decorate([
    (0, mongoose_1.Prop)({ required: true }),
    __metadata("design:type", String)
], DailyReportTask.prototype, "title", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true, enum: ['urgent', 'high', 'medium', 'low'] }),
    __metadata("design:type", String)
], DailyReportTask.prototype, "priority", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], DailyReportTask.prototype, "category", void 0);
__decorate([
    (0, mongoose_1.Prop)({ default: false }),
    __metadata("design:type", Boolean)
], DailyReportTask.prototype, "isOverdue", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true, enum: ['todo', 'in_progress', 'done'], default: 'todo' }),
    __metadata("design:type", String)
], DailyReportTask.prototype, "status", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], DailyReportTask.prototype, "relatedDealId", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], DailyReportTask.prototype, "relatedQuoteId", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], DailyReportTask.prototype, "relatedEmailId", void 0);
__decorate([
    (0, mongoose_1.Prop)({ index: true }),
    __metadata("design:type", String)
], DailyReportTask.prototype, "assignedUserId", void 0);
exports.DailyReportTask = DailyReportTask = __decorate([
    (0, mongoose_1.Schema)()
], DailyReportTask);
const DailyReportTaskSchema = mongoose_1.SchemaFactory.createForClass(DailyReportTask);
let DailyReport = class DailyReport {
};
exports.DailyReport = DailyReport;
__decorate([
    (0, mongoose_1.Prop)({ required: true, index: true }),
    __metadata("design:type", String)
], DailyReport.prototype, "organizationId", void 0);
__decorate([
    (0, mongoose_1.Prop)({ index: true }),
    __metadata("design:type", String)
], DailyReport.prototype, "storeId", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true, index: true }),
    __metadata("design:type", String)
], DailyReport.prototype, "agentId", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true, enum: ['morning', 'eod'] }),
    __metadata("design:type", String)
], DailyReport.prototype, "reportType", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true, index: true }),
    __metadata("design:type", String)
], DailyReport.prototype, "date", void 0);
__decorate([
    (0, mongoose_1.Prop)({ type: [DailyReportTaskSchema], default: [] }),
    __metadata("design:type", Array)
], DailyReport.prototype, "tasks", void 0);
__decorate([
    (0, mongoose_1.Prop)({ default: '' }),
    __metadata("design:type", String)
], DailyReport.prototype, "summary", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true }),
    __metadata("design:type", String)
], DailyReport.prototype, "sourceConversationId", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true }),
    __metadata("design:type", String)
], DailyReport.prototype, "sourceUserId", void 0);
__decorate([
    (0, mongoose_1.Prop)({ default: false }),
    __metadata("design:type", Boolean)
], DailyReport.prototype, "wasMissed", void 0);
__decorate([
    (0, mongoose_1.Prop)({ enum: ['pending', 'sent', 'failed'], default: 'pending' }),
    __metadata("design:type", String)
], DailyReport.prototype, "emailStatus", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", Date)
], DailyReport.prototype, "emailSentAt", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], DailyReport.prototype, "emailError", void 0);
exports.DailyReport = DailyReport = __decorate([
    (0, mongoose_1.Schema)({ timestamps: true, collection: 'daily_reports' })
], DailyReport);
exports.DailyReportSchema = mongoose_1.SchemaFactory.createForClass(DailyReport);
exports.DailyReportSchema.index({ organizationId: 1, storeId: 1, agentId: 1, reportType: 1, date: 1 }, { unique: true });
//# sourceMappingURL=daily-report.schema.js.map