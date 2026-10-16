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
var OutlookController_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.OutlookController = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const jwt_1 = require("@nestjs/jwt");
const jwt_auth_guard_1 = require("../common/guards/jwt-auth.guard");
const current_user_decorator_1 = require("../common/decorators/current-user.decorator");
const cloud_connections_service_1 = require("../cloud-files/cloud-connections.service");
const outlook_service_1 = require("./outlook.service");
let OutlookController = OutlookController_1 = class OutlookController {
    constructor(outlookService, jwtService, config, cloudConnections) {
        this.outlookService = outlookService;
        this.jwtService = jwtService;
        this.config = config;
        this.cloudConnections = cloudConnections;
        this.logger = new common_1.Logger(OutlookController_1.name);
    }
    getEmails() {
        return this.outlookService.getEmails();
    }
    getCalendarEvents() {
        return this.outlookService.getCalendarEvents();
    }
    getContacts() {
        return this.outlookService.getContacts();
    }
    getConnectUrl(user) {
        const state = this.jwtService.sign({ sub: user.sub, organizationId: user.organizationId }, { expiresIn: '10m' });
        return { url: this.outlookService.buildAuthorizeUrl(state) };
    }
    async callback(code, state, error, errorDescription) {
        const cloud = this.cloudConnections.readState(state);
        if (cloud)
            return { url: await this.cloudConnections.finish(cloud, code, error, errorDescription), statusCode: 302 };
        const frontendUrl = this.config.get('corsOrigin');
        if (error || !code || !state) {
            this.logger.warn(`Outlook callback missing params (error=${error}, description=${errorDescription})`);
            const reason = (0, outlook_service_1.isAdminConsentRequiredError)(errorDescription) ? 'admin_consent_required' : 'error';
            return { url: `${frontendUrl}/integrations?outlook=${reason}`, statusCode: 302 };
        }
        try {
            const payload = this.jwtService.verify(state);
            await this.outlookService.handleCallback(code, payload.sub, payload.organizationId);
            return { url: `${frontendUrl}/integrations?outlook=connected`, statusCode: 302 };
        }
        catch (err) {
            const detail = err.response?.data ?? err.message;
            this.logger.error(`Outlook callback failed: ${JSON.stringify(detail)}`);
            return { url: `${frontendUrl}/integrations?outlook=error`, statusCode: 302 };
        }
    }
    getAdminConsentUrl(user) {
        const state = this.jwtService.sign({ sub: user.sub, organizationId: user.organizationId, email: user.email }, { expiresIn: '10m' });
        return { url: this.outlookService.buildAdminConsentUrl(state) };
    }
    async adminConsentCallback(tenant, adminConsent, state, error, errorDescription) {
        const frontendUrl = this.config.get('corsOrigin');
        if (error || adminConsent !== 'True' || !tenant || !state) {
            this.logger.warn(`Admin consent declined or failed (error=${error}, description=${errorDescription})`);
            return { url: `${frontendUrl}/integrations?outlook=admin_consent_declined`, statusCode: 302 };
        }
        try {
            const payload = this.jwtService.verify(state);
            await this.outlookService.recordTenantAuthorization(tenant, payload.organizationId, payload.sub, payload.email);
            return { url: `${frontendUrl}/integrations?outlook=admin_consent_granted`, statusCode: 302 };
        }
        catch (err) {
            this.logger.error(`Admin consent callback failed: ${err.message}`);
            return { url: `${frontendUrl}/integrations?outlook=error`, statusCode: 302 };
        }
    }
    getTenantAuthorizationStatus(user) {
        return this.outlookService.getTenantAuthorizationStatus(user.organizationId);
    }
    getStatus(user) {
        return this.outlookService.getStatus(user.sub);
    }
    listAccounts(user) {
        return this.outlookService.listAccounts(user.sub);
    }
    setActive(user, email) {
        return this.outlookService.setActive(user.sub, decodeURIComponent(email));
    }
    setHandler(user, email, body) {
        return this.outlookService.setHandler(user.sub, user.organizationId, decodeURIComponent(email), body?.userId || null);
    }
    disconnectAccount(user, email) {
        return this.outlookService.disconnect(user.sub, decodeURIComponent(email));
    }
    listOrgAccounts(user) {
        return this.outlookService.listOrgAccounts(user.organizationId);
    }
};
exports.OutlookController = OutlookController;
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Get)('emails'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], OutlookController.prototype, "getEmails", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Get)('calendar'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], OutlookController.prototype, "getCalendarEvents", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Get)('contacts'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], OutlookController.prototype, "getContacts", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Get)('connect-url'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], OutlookController.prototype, "getConnectUrl", null);
__decorate([
    (0, common_1.Get)('callback'),
    (0, common_1.Redirect)(),
    __param(0, (0, common_1.Query)('code')),
    __param(1, (0, common_1.Query)('state')),
    __param(2, (0, common_1.Query)('error')),
    __param(3, (0, common_1.Query)('error_description')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String]),
    __metadata("design:returntype", Promise)
], OutlookController.prototype, "callback", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Get)('admin-consent-url'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], OutlookController.prototype, "getAdminConsentUrl", null);
__decorate([
    (0, common_1.Get)('admin-consent-callback'),
    (0, common_1.Redirect)(),
    __param(0, (0, common_1.Query)('tenant')),
    __param(1, (0, common_1.Query)('admin_consent')),
    __param(2, (0, common_1.Query)('state')),
    __param(3, (0, common_1.Query)('error')),
    __param(4, (0, common_1.Query)('error_description')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String, String]),
    __metadata("design:returntype", Promise)
], OutlookController.prototype, "adminConsentCallback", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Get)('tenant-authorization-status'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], OutlookController.prototype, "getTenantAuthorizationStatus", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Get)('status'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], OutlookController.prototype, "getStatus", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Get)('accounts'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], OutlookController.prototype, "listAccounts", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Post)('accounts/:email/activate'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('email')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], OutlookController.prototype, "setActive", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Put)('accounts/:email/handler'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('email')),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], OutlookController.prototype, "setHandler", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Delete)('accounts/:email'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('email')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], OutlookController.prototype, "disconnectAccount", null);
__decorate([
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    (0, common_1.Get)('org-accounts'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], OutlookController.prototype, "listOrgAccounts", null);
exports.OutlookController = OutlookController = OutlookController_1 = __decorate([
    (0, common_1.Controller)('outlook'),
    __metadata("design:paramtypes", [outlook_service_1.OutlookService,
        jwt_1.JwtService,
        config_1.ConfigService,
        cloud_connections_service_1.CloudConnectionsService])
], OutlookController);
//# sourceMappingURL=outlook.controller.js.map