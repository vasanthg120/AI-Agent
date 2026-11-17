"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentRolesModule = void 0;
const axios_1 = require("@nestjs/axios");
const common_1 = require("@nestjs/common");
const mongoose_1 = require("@nestjs/mongoose");
const auth_module_1 = require("../auth/auth.module");
const agent_roles_controller_1 = require("./agent-roles.controller");
const agent_roles_service_1 = require("./agent-roles.service");
const agent_role_schema_1 = require("./schemas/agent-role.schema");
let AgentRolesModule = class AgentRolesModule {
};
exports.AgentRolesModule = AgentRolesModule;
exports.AgentRolesModule = AgentRolesModule = __decorate([
    (0, common_1.Module)({
        imports: [
            mongoose_1.MongooseModule.forFeature([{ name: agent_role_schema_1.AgentRole.name, schema: agent_role_schema_1.AgentRoleSchema }]),
            axios_1.HttpModule.register({ timeout: 60_000 }),
            auth_module_1.AuthModule,
        ],
        controllers: [agent_roles_controller_1.AgentRolesController],
        providers: [agent_roles_service_1.AgentRolesService],
    })
], AgentRolesModule);
//# sourceMappingURL=agent-roles.module.js.map