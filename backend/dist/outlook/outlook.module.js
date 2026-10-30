"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OutlookModule = void 0;
const axios_1 = require("@nestjs/axios");
const common_1 = require("@nestjs/common");
const mongoose_1 = require("@nestjs/mongoose");
const auth_module_1 = require("../auth/auth.module");
const integrations_module_1 = require("../integrations/integrations.module");
const users_module_1 = require("../users/users.module");
const outlook_controller_1 = require("./outlook.controller");
const outlook_connection_schema_1 = require("./schemas/outlook-connection.schema");
const microsoft_tenant_authorization_schema_1 = require("./schemas/microsoft-tenant-authorization.schema");
const outlook_service_1 = require("./outlook.service");
let OutlookModule = class OutlookModule {
};
exports.OutlookModule = OutlookModule;
exports.OutlookModule = OutlookModule = __decorate([
    (0, common_1.Module)({
        imports: [
            mongoose_1.MongooseModule.forFeature([
                { name: outlook_connection_schema_1.OutlookConnection.name, schema: outlook_connection_schema_1.OutlookConnectionSchema },
                { name: microsoft_tenant_authorization_schema_1.MicrosoftTenantAuthorization.name, schema: microsoft_tenant_authorization_schema_1.MicrosoftTenantAuthorizationSchema },
            ]),
            axios_1.HttpModule.register({ timeout: 15_000 }),
            auth_module_1.AuthModule,
            users_module_1.UsersModule,
            integrations_module_1.IntegrationsModule,
        ],
        controllers: [outlook_controller_1.OutlookController],
        providers: [outlook_service_1.OutlookService],
    })
], OutlookModule);
//# sourceMappingURL=outlook.module.js.map