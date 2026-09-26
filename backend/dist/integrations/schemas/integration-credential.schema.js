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
exports.IntegrationCredentialSchema = exports.IntegrationCredential = void 0;
const mongoose_1 = require("@nestjs/mongoose");
let IntegrationCredential = class IntegrationCredential {
};
exports.IntegrationCredential = IntegrationCredential;
__decorate([
    (0, mongoose_1.Prop)({ required: true, index: true }),
    __metadata("design:type", String)
], IntegrationCredential.prototype, "organizationId", void 0);
__decorate([
    (0, mongoose_1.Prop)({ required: true }),
    __metadata("design:type", String)
], IntegrationCredential.prototype, "provider", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], IntegrationCredential.prototype, "apiKey", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], IntegrationCredential.prototype, "baseUrl", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], IntegrationCredential.prototype, "authType", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], IntegrationCredential.prototype, "credentialsEncrypted", void 0);
__decorate([
    (0, mongoose_1.Prop)(),
    __metadata("design:type", String)
], IntegrationCredential.prototype, "healthCheckPath", void 0);
__decorate([
    (0, mongoose_1.Prop)({ type: Number }),
    __metadata("design:type", Number)
], IntegrationCredential.prototype, "budgetUsd", void 0);
__decorate([
    (0, mongoose_1.Prop)({ enum: ['monthly', 'total'], default: 'monthly' }),
    __metadata("design:type", String)
], IntegrationCredential.prototype, "budgetPeriod", void 0);
exports.IntegrationCredential = IntegrationCredential = __decorate([
    (0, mongoose_1.Schema)({ timestamps: true, collection: 'integration_credentials' })
], IntegrationCredential);
exports.IntegrationCredentialSchema = mongoose_1.SchemaFactory.createForClass(IntegrationCredential);
exports.IntegrationCredentialSchema.index({ organizationId: 1, provider: 1 }, { unique: true });
//# sourceMappingURL=integration-credential.schema.js.map