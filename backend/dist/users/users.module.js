"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UsersModule = void 0;
const common_1 = require("@nestjs/common");
const mongoose_1 = require("@nestjs/mongoose");
const agent_role_schema_1 = require("../agent-roles/schemas/agent-role.schema");
const user_schema_1 = require("./schemas/user.schema");
const invitations_service_1 = require("./invitations.service");
const users_controller_1 = require("./users.controller");
const users_index_migration_1 = require("./users-index.migration");
const users_service_1 = require("./users.service");
let UsersModule = class UsersModule {
};
exports.UsersModule = UsersModule;
exports.UsersModule = UsersModule = __decorate([
    (0, common_1.Module)({
        imports: [
            mongoose_1.MongooseModule.forFeature([
                { name: user_schema_1.User.name, schema: user_schema_1.UserSchema },
                { name: agent_role_schema_1.AgentRole.name, schema: agent_role_schema_1.AgentRoleSchema },
            ]),
        ],
        controllers: [users_controller_1.UsersController],
        providers: [users_service_1.UsersService, users_index_migration_1.UsersIndexMigration, invitations_service_1.InvitationsService],
        exports: [users_service_1.UsersService, invitations_service_1.InvitationsService],
    })
], UsersModule);
//# sourceMappingURL=users.module.js.map