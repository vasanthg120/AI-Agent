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
exports.AgentRolesController = void 0;
const platform_express_1 = require("@nestjs/platform-express");
const common_1 = require("@nestjs/common");
const current_user_decorator_1 = require("../common/decorators/current-user.decorator");
const roles_decorator_1 = require("../common/decorators/roles.decorator");
const jwt_auth_guard_1 = require("../common/guards/jwt-auth.guard");
const roles_guard_1 = require("../common/guards/roles.guard");
const upload_limits_1 = require("../common/upload-limits");
const agent_roles_service_1 = require("./agent-roles.service");
const create_agent_role_dto_1 = require("./dto/create-agent-role.dto");
const generate_from_description_dto_1 = require("./dto/generate-from-description.dto");
const update_agent_role_dto_1 = require("./dto/update-agent-role.dto");
const permission_decorator_1 = require("../common/permissions/permission.decorator");
let AgentRolesController = class AgentRolesController {
    constructor(agentRolesService) {
        this.agentRolesService = agentRolesService;
    }
    list(user) {
        return this.agentRolesService.listAll(user.organizationId);
    }
    generate(user, req, file) {
        const bearerToken = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        return this.agentRolesService.generateDraft(user.sub, user.organizationId, bearerToken, file);
    }
    generateFromDescription(user, dto) {
        return this.agentRolesService.generateFromDescription(user.sub, user.organizationId, dto.description);
    }
    create(user, dto) {
        return this.agentRolesService.createManual(user.sub, user.organizationId, dto);
    }
    update(user, id, dto, req) {
        if (dto.status !== undefined && (0, permission_decorator_1.isPermissionManaged)(user) && !(0, permission_decorator_1.holdsPermission)(user, 'ai_roles', 'manage')) {
            throw new common_1.ForbiddenException('You don’t have permission to activate AI roles or set them back to draft. Ask an admin for access.');
        }
        const bearerToken = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        return this.agentRolesService.update(id, dto, bearerToken, user.organizationId);
    }
    remove(user, id, req) {
        const bearerToken = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        return this.agentRolesService.remove(id, bearerToken, user.organizationId);
    }
};
exports.AgentRolesController = AgentRolesController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AgentRolesController.prototype, "list", null);
__decorate([
    (0, common_1.Post)('generate'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('admin'),
    (0, common_1.UseInterceptors)((0, platform_express_1.FileInterceptor)('file', upload_limits_1.UPLOAD_FILE_INTERCEPTOR_OPTIONS)),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.UploadedFile)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", void 0)
], AgentRolesController.prototype, "generate", null);
__decorate([
    (0, common_1.Post)('generate-from-description'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('admin'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, generate_from_description_dto_1.GenerateFromDescriptionDto]),
    __metadata("design:returntype", void 0)
], AgentRolesController.prototype, "generateFromDescription", null);
__decorate([
    (0, common_1.Post)(),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('admin'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, create_agent_role_dto_1.CreateAgentRoleDto]),
    __metadata("design:returntype", void 0)
], AgentRolesController.prototype, "create", null);
__decorate([
    (0, common_1.Patch)(':id'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('admin'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)()),
    __param(3, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, update_agent_role_dto_1.UpdateAgentRoleDto, Object]),
    __metadata("design:returntype", void 0)
], AgentRolesController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('admin'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], AgentRolesController.prototype, "remove", null);
exports.AgentRolesController = AgentRolesController = __decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, permission_decorator_1.Permission)('ai_roles'),
    (0, common_1.Controller)('agent-roles'),
    __metadata("design:paramtypes", [agent_roles_service_1.AgentRolesService])
], AgentRolesController);
//# sourceMappingURL=agent-roles.controller.js.map