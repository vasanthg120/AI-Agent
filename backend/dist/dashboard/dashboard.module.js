"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DashboardModule = void 0;
const axios_1 = require("@nestjs/axios");
const common_1 = require("@nestjs/common");
const mongoose_1 = require("@nestjs/mongoose");
const auth_module_1 = require("../auth/auth.module");
const billing_module_1 = require("../billing/billing.module");
const chat_module_1 = require("../chat/chat.module");
const gamification_module_1 = require("../gamification/gamification.module");
const timeline_module_1 = require("../timeline/timeline.module");
const dashboard_controller_1 = require("./dashboard.controller");
const dashboard_service_1 = require("./dashboard.service");
const tasks_controller_1 = require("./tasks.controller");
const tasks_service_1 = require("./tasks.service");
const tasks_export_service_1 = require("./tasks-export.service");
const daily_report_schema_1 = require("./schemas/daily-report.schema");
let DashboardModule = class DashboardModule {
};
exports.DashboardModule = DashboardModule;
exports.DashboardModule = DashboardModule = __decorate([
    (0, common_1.Module)({
        imports: [
            mongoose_1.MongooseModule.forFeature([{ name: daily_report_schema_1.DailyReport.name, schema: daily_report_schema_1.DailyReportSchema }]),
            axios_1.HttpModule.register({ timeout: 120_000 }),
            auth_module_1.AuthModule,
            chat_module_1.ChatModule,
            gamification_module_1.GamificationModule,
            timeline_module_1.TimelineModule,
            billing_module_1.BillingModule,
        ],
        controllers: [dashboard_controller_1.DashboardController, tasks_controller_1.TasksController],
        providers: [dashboard_service_1.DashboardService, tasks_service_1.TasksService, tasks_export_service_1.TasksExportService],
        exports: [dashboard_service_1.DashboardService],
    })
], DashboardModule);
//# sourceMappingURL=dashboard.module.js.map