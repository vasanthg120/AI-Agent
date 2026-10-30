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
exports.OutlookService = void 0;
exports.isAdminConsentRequiredError = isAdminConsentRequiredError;
const axios_1 = require("@nestjs/axios");
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const mongoose_1 = require("@nestjs/mongoose");
const mongoose_2 = require("mongoose");
const rxjs_1 = require("rxjs");
const encryption_service_1 = require("../common/encryption/encryption.service");
const integrations_service_1 = require("../integrations/integrations.service");
const users_service_1 = require("../users/users.service");
const outlook_connection_schema_1 = require("./schemas/outlook-connection.schema");
const microsoft_tenant_authorization_schema_1 = require("./schemas/microsoft-tenant-authorization.schema");
const GRAPH_SCOPES = 'offline_access User.Read Mail.Read Mail.Send Calendars.Read Calendars.ReadWrite Contacts.Read';
function isAdminConsentRequiredError(errorDescription) {
    if (!errorDescription)
        return false;
    return /AADSTS90094|admin approval|admin consent/i.test(errorDescription);
}
const PLATFORM_INTEGRATION_SCOPE = 'platform';
let OutlookService = class OutlookService {
    constructor(config, http, encryption, usersService, integrations, connectionModel, tenantAuthModel) {
        this.config = config;
        this.http = http;
        this.encryption = encryption;
        this.usersService = usersService;
        this.integrations = integrations;
        this.connectionModel = connectionModel;
        this.tenantAuthModel = tenantAuthModel;
    }
    get configured() {
        return Boolean(this.config.get('integrations.msGraph.clientId'));
    }
    async resolveAppCredentials() {
        const saved = await this.integrations.resolveOAuthAppCredentials(PLATFORM_INTEGRATION_SCOPE, 'outlook');
        if (saved)
            return saved;
        const envClientId = this.config.get('integrations.msGraph.clientId');
        const envClientSecret = this.config.get('integrations.msGraph.clientSecret');
        if (!envClientId || !envClientSecret) {
            throw new common_1.BadRequestException({
                code: 'OUTLOOK_APP_CREDENTIALS_REQUIRED',
                message: 'Outlook is not available yet — ask your Haive administrator to configure Microsoft OAuth.',
            });
        }
        return { clientId: envClientId, clientSecret: envClientSecret };
    }
    async getEmails() {
        if (!this.configured)
            return this.placeholderEmails();
        return this.placeholderEmails();
    }
    async getCalendarEvents() {
        return [];
    }
    async getContacts() {
        return [];
    }
    placeholderEmails() {
        return [
            {
                id: 'msg-1',
                from: 'client@example.com',
                subject: 'Following up on our proposal',
                receivedAt: new Date().toISOString(),
            },
        ];
    }
    async buildAuthorizeUrl(state) {
        const { clientId } = await this.resolveAppCredentials();
        const redirectUri = this.config.get('integrations.msGraph.redirectUri');
        const params = new URLSearchParams({
            client_id: clientId,
            response_type: 'code',
            redirect_uri: redirectUri ?? '',
            response_mode: 'query',
            scope: GRAPH_SCOPES,
            prompt: 'select_account',
            state,
        });
        return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;
    }
    async buildAdminConsentUrl(state) {
        const { clientId } = await this.resolveAppCredentials();
        const redirectUri = this.config.get('integrations.msGraph.adminConsentRedirectUri');
        const params = new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirectUri ?? '',
            state,
        });
        return `https://login.microsoftonline.com/organizations/adminconsent?${params.toString()}`;
    }
    async recordTenantAuthorization(tenantId, organizationId, userId, userEmail) {
        await this.tenantAuthModel.findOneAndUpdate({ tenantId }, { tenantId, organizationId, authorizedByUserId: userId, authorizedByEmail: userEmail }, { upsert: true });
    }
    async getTenantAuthorizationStatus(organizationId) {
        const doc = await this.tenantAuthModel.findOne({ organizationId }).sort({ createdAt: -1 });
        if (!doc)
            return { authorized: false };
        return { authorized: true, tenantId: doc.tenantId, authorizedByEmail: doc.authorizedByEmail };
    }
    async handleCallback(code, userId, organizationId) {
        const tokens = await this.exchangeCode(code);
        const email = await this.fetchUserEmail(tokens.access_token);
        const { tenantId: microsoftTenantId, userId: microsoftUserId } = this.decodeAccessTokenClaims(tokens.access_token);
        await this.connectionModel.updateMany({ userId }, { isActive: false });
        await this.connectionModel.findOneAndUpdate({ userId, email }, {
            userId,
            organizationId,
            email,
            microsoftTenantId,
            microsoftUserId,
            accessToken: this.encryption.encrypt(tokens.access_token),
            refreshToken: this.encryption.encrypt(tokens.refresh_token),
            expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
            scope: tokens.scope,
            isActive: true,
            status: 'connected',
        }, { upsert: true });
        return { email };
    }
    decodeAccessTokenClaims(accessToken) {
        try {
            const payload = accessToken.split('.')[1];
            const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
            return { tenantId: claims.tid, userId: claims.oid };
        }
        catch {
            return {};
        }
    }
    async getStatus(userId) {
        const active = await this.connectionModel.findOne({ userId, isActive: true }).select({ email: 1, scope: 1 });
        return { connected: Boolean(active), email: active?.email, canSend: !!active?.scope?.includes('Mail.Send') };
    }
    async setHandler(userId, organizationId, email, handlerUserId) {
        const connection = await this.connectionModel.findOne({ userId, email }).exec();
        if (!connection)
            throw new common_1.NotFoundException('That mailbox isn’t connected to your account.');
        if (handlerUserId) {
            const handler = /^[0-9a-f]{24}$/i.test(handlerUserId)
                ? await this.connectionModel.db.collection('users').findOne({ _id: new mongoose_2.Types.ObjectId(handlerUserId), organizationId }, { projection: { active: 1 } })
                : null;
            if (!handler)
                throw new common_1.BadRequestException('That person isn’t in your organization. Pick someone from the list.');
            if (handler.active === false)
                throw new common_1.BadRequestException('That person is deactivated.');
            connection.handledByUserId = handlerUserId;
        }
        else {
            connection.handledByUserId = undefined;
        }
        await connection.save();
        return this.listAccounts(userId);
    }
    async listAccounts(userId) {
        const connections = await this.connectionModel
            .find({ userId })
            .select({ email: 1, isActive: 1, createdAt: 1, status: 1, handledByUserId: 1 })
            .sort({ createdAt: -1 });
        return connections.map((c) => ({
            email: c.email,
            handledByUserId: c.handledByUserId,
            isActive: c.isActive,
            connectedAt: c.createdAt,
            status: c.status ?? 'connected',
        }));
    }
    async listOrgAccounts(organizationId) {
        const connections = await this.connectionModel
            .find({ organizationId })
            .select({ userId: 1, email: 1, isActive: 1, createdAt: 1, status: 1 })
            .sort({ createdAt: -1 });
        const ownerIds = [...new Set(connections.map((c) => c.userId))];
        const owners = await Promise.all(ownerIds.map((id) => this.usersService.findById(id)));
        const ownersById = new Map(owners.filter(Boolean).map((u) => [u._id.toString(), u]));
        return connections.map((c) => {
            const owner = ownersById.get(c.userId);
            return {
                email: c.email,
                isActive: c.isActive,
                connectedAt: c.createdAt,
                status: c.status ?? 'connected',
                ownerUserId: c.userId,
                ownerName: owner?.name ?? 'Unknown',
                ownerEmail: owner?.email ?? '',
            };
        });
    }
    async setActive(userId, email) {
        const target = await this.connectionModel.findOne({ userId, email });
        if (!target)
            throw new common_1.NotFoundException(`No connected Outlook account for ${email}`);
        await this.connectionModel.updateMany({ userId }, { isActive: false });
        await this.connectionModel.updateOne({ userId, email }, { isActive: true });
    }
    async disconnect(userId, email) {
        const wasActive = await this.connectionModel.findOne({ userId, email }).select({ isActive: 1 });
        await this.connectionModel.deleteOne({ userId, email });
        if (wasActive?.isActive) {
            const next = await this.connectionModel.findOne({ userId }).sort({ createdAt: -1 });
            if (next)
                await this.connectionModel.updateOne({ _id: next._id }, { isActive: true });
        }
    }
    tokenEndpoint() {
        return `https://login.microsoftonline.com/common/oauth2/v2.0/token`;
    }
    async exchangeCode(code) {
        const { clientId, clientSecret } = await this.resolveAppCredentials();
        const redirectUri = this.config.get('integrations.msGraph.redirectUri');
        const body = new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri ?? '',
            scope: GRAPH_SCOPES,
        });
        const response = await (0, rxjs_1.firstValueFrom)(this.http.post(this.tokenEndpoint(), body.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }));
        return response.data;
    }
    async fetchUserEmail(accessToken) {
        const response = await (0, rxjs_1.firstValueFrom)(this.http.get('https://graph.microsoft.com/v1.0/me', {
            headers: { Authorization: `Bearer ${accessToken}` },
        }));
        return response.data.mail ?? response.data.userPrincipalName;
    }
};
exports.OutlookService = OutlookService;
exports.OutlookService = OutlookService = __decorate([
    (0, common_1.Injectable)(),
    __param(5, (0, mongoose_1.InjectModel)(outlook_connection_schema_1.OutlookConnection.name)),
    __param(6, (0, mongoose_1.InjectModel)(microsoft_tenant_authorization_schema_1.MicrosoftTenantAuthorization.name)),
    __metadata("design:paramtypes", [config_1.ConfigService,
        axios_1.HttpService,
        encryption_service_1.EncryptionService,
        users_service_1.UsersService,
        integrations_service_1.IntegrationsService,
        mongoose_2.Model,
        mongoose_2.Model])
], OutlookService);
//# sourceMappingURL=outlook.service.js.map