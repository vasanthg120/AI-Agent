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
exports.AgentRoleSchema = exports.AgentRole = exports.ROLE_CATEGORIES = void 0;
const mongoose_1 = require("@nestjs/mongoose");
exports.ROLE_CATEGORIES = ['sales', 'finance', 'hr', 'support', 'marketing', 'operations', 'custom'];
let AgentRole = class AgentRole {
};
exports.AgentRole = AgentRole;
__decorate([
    (0, mongoose_1.Prop)({ required: true, index: true }),
    __metadata("design:type", String)
], AgentRole.prototype, "organizationId", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true, index: true }),
    __metadata("design:type", String)
], AgentRole.prototype, "slug", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true }),
    __metadata("design:type", String)
], AgentRole.prototype, "name", void 0);
__decorate([
    (0, mongoose_1.Prop)({ default: '' }),
    __metadata("design:type", String)
], AgentRole.prototype, "department", void 0);
__decorate([
    (0, mongoose_1.Prop)({ default: '' }),
    __metadata("design:type", String)
], AgentRole.prototype, "description", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true }),
    __metadata("design:type", String)
], AgentRole.prototype, "systemPrompt", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], AgentRole.prototype, "sourceDocumentName", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], AgentRole.prototype, "sourceDocumentId", void 0);
__decorate([
    (0, mongoose_1.Prop)({ enum: ['draft', 'active'], default: 'draft', index: true }),
    __metadata("design:type", String)
], AgentRole.prototype, "status", void 0);
__decorate([
    (0, mongoose_1.Prop)({ type: [String], default: [] }),
    __metadata("design:type", Array)
], AgentRole.prototype, "assignedDepartments", void 0);
__decorate([
    (0, mongoose_1.Prop)({ type: [String], default: [] }),
    __metadata("design:type", Array)
], AgentRole.prototype, "assignedUserIds", void 0);
__decorate([
    (0, mongoose_1.Prop)({ type: [String], default: [] }),
    __metadata("design:type", Array)
], AgentRole.prototype, "allowedTools", void 0);
__decorate([
    (0, mongoose_1.Prop)({ enum: ['fast', 'standard'] }),
    __metadata("design:type", String)
], AgentRole.prototype, "modelTier", void 0);
__decorate([
    (0, mongoose_1.Prop)({ default: '#6b7280' }),
    __metadata("design:type", String)
], AgentRole.prototype, "avatarColor", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true }),
    __metadata("design:type", String)
], AgentRole.prototype, "createdBy", void 0);
exports.AgentRole = AgentRole = __decorate([
    (0, mongoose_1.Schema)({ timestamps: true, collection: 'agent_roles' })
], AgentRole);
exports.AgentRoleSchema = mongoose_1.SchemaFactory.createForClass(AgentRole);
exports.AgentRoleSchema.index({ organizationId: 1, slug: 1 }, { unique: true });
//# sourceMappingURL=agent-role.schema.js.map