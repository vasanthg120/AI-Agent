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
var AuditService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditService = void 0;
const common_1 = require("@nestjs/common");
const mongoose_1 = require("@nestjs/mongoose");
const mongoose_2 = require("mongoose");
const audit_log_schema_1 = require("./schemas/audit-log.schema");
let AuditService = AuditService_1 = class AuditService {
    constructor(auditModel) {
        this.auditModel = auditModel;
        this.logger = new common_1.Logger(AuditService_1.name);
    }
    async log(entry) {
        try {
            await this.auditModel.create(entry);
        }
        catch (err) {
            this.logger.warn(`Failed to write audit log entry: ${err.message}`);
        }
    }
    list(organizationId, limit = 200) {
        return this.auditModel.find({ organizationId }).sort({ createdAt: -1 }).limit(limit).exec();
    }
    async listAll(filters) {
        const page = filters.page ?? 1;
        const limit = filters.limit ?? 100;
        const query = {};
        if (filters.userId)
            query.userId = filters.userId;
        if (filters.route)
            query.route = { $regex: filters.route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
        const [items, total] = await Promise.all([
            this.auditModel.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).exec(),
            this.auditModel.countDocuments(query).exec(),
        ]);
        return { items, total, page, limit };
    }
};
exports.AuditService = AuditService;
exports.AuditService = AuditService = AuditService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, mongoose_1.InjectModel)(audit_log_schema_1.AuditLog.name)),
    __metadata("design:paramtypes", [mongoose_2.Model])
], AuditService);
//# sourceMappingURL=audit.service.js.map