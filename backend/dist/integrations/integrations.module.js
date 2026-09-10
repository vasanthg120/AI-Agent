"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntegrationsModule = void 0;
const axios_1 = require("@nestjs/axios");
const common_1 = require("@nestjs/common");
const mongoose_1 = require("@nestjs/mongoose");
const auth_module_1 = require("../auth/auth.module");
const admin_integrations_controller_1 = require("./admin-integrations.controller");
const dynamic_executor_service_1 = require("./dynamic-executor.service");
const integration_resources_service_1 = require("./integration-resources.service");
const integrations_controller_1 = require("./integrations.controller");
const integrations_service_1 = require("./integrations.service");
const resources_controller_1 = require("./resources.controller");
const integration_credential_schema_1 = require("./schemas/integration-credential.schema");
const integration_endpoint_schema_1 = require("./schemas/integration-endpoint.schema");
const integration_resource_schema_1 = require("./schemas/integration-resource.schema");
let IntegrationsModule = class IntegrationsModule {
};
exports.IntegrationsModule = IntegrationsModule;
exports.IntegrationsModule = IntegrationsModule = __decorate([
    (0, common_1.Module)({
        imports: [
            mongoose_1.MongooseModule.forFeature([
                { name: integration_credential_schema_1.IntegrationCredential.name, schema: integration_credential_schema_1.IntegrationCredentialSchema },
                { name: integration_resource_schema_1.IntegrationResource.name, schema: integration_resource_schema_1.IntegrationResourceSchema },
                { name: integration_endpoint_schema_1.IntegrationEndpoint.name, schema: integration_endpoint_schema_1.IntegrationEndpointSchema },
            ]),
            axios_1.HttpModule.register({ timeout: 15_000 }),
            auth_module_1.AuthModule,
        ],
        controllers: [integrations_controller_1.IntegrationsController, resources_controller_1.ResourcesController, admin_integrations_controller_1.AdminIntegrationsController],
        providers: [integrations_service_1.IntegrationsService, integration_resources_service_1.IntegrationResourcesService, dynamic_executor_service_1.DynamicExecutorService],
    })
], IntegrationsModule);
//# sourceMappingURL=integrations.module.js.map