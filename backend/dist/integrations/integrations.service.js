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
var IntegrationsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntegrationsService = void 0;
const axios_1 = require("@nestjs/axios");
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const jwt_1 = require("@nestjs/jwt");
const mongoose_1 = require("@nestjs/mongoose");
const mongoose_2 = require("mongoose");
const rxjs_1 = require("rxjs");
const ssrf_guard_1 = require("../common/security/ssrf-guard");
const encryption_service_1 = require("../common/encryption/encryption.service");
const auth_methods_1 = require("./auth-methods");
const provider_rules_1 = require("./provider-rules");
const integration_credential_schema_1 = require("./schemas/integration-credential.schema");
const CRM_PROVIDERS = new Set(['crm', 'prospectconnect']);
const PROVIDER_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
let IntegrationsService = IntegrationsService_1 = class IntegrationsService {
    constructor(credentialModel, encryption, http, jwt, config) {
        this.credentialModel = credentialModel;
        this.encryption = encryption;
        this.http = http;
        this.jwt = jwt;
        this.config = config;
        this.logger = new common_1.Logger(IntegrationsService_1.name);
        this.pythonAgentUrl = this.config.get('pythonAgentUrl') ?? 'http://localhost:8000';
    }
    async syncCrmNow(organizationId) {
        const token = this.jwt.sign({ sub: 'system', organizationId }, { expiresIn: '5m' });
        const { data } = await (0, rxjs_1.firstValueFrom)(this.http.post(`${this.pythonAgentUrl}/sync/crm/run-for-org`, {}, { headers: { Authorization: `Bearer ${token}` } }));
        return data;
    }
    triggerCrmSyncIfApplicable(organizationId, provider) {
        if (!CRM_PROVIDERS.has(provider))
            return;
        this.syncCrmNow(organizationId).catch((err) => {
            this.logger.error(`Immediate CRM sync failed for org ${organizationId}: ${err.message}`);
        });
    }
    async connect(organizationId, provider, apiKey, baseUrl) {
        this.assertAllowed(provider);
        await this.credentialModel.findOneAndUpdate({ organizationId, provider }, { organizationId, provider, apiKey: this.encryption.encrypt(apiKey), baseUrl, authType: undefined, credentialsEncrypted: undefined }, { upsert: true });
        this.triggerCrmSyncIfApplicable(organizationId, provider);
        return { connected: true, maskedKey: this.mask(apiKey), baseUrl };
    }
    async connectWithAuth(organizationId, provider, dto) {
        const authType = dto.authType;
        this.assertAllowed(provider, authType);
        const credentials = (dto.credentials ?? {});
        const missing = (0, auth_methods_1.requiredCredentialFields)(authType).filter((field) => !credentials[field]);
        if (missing.length > 0) {
            throw new common_1.BadRequestException(`Missing required field(s) for ${authType}: ${missing.join(', ')}`);
        }
        await this.credentialModel.findOneAndUpdate({ organizationId, provider }, {
            organizationId,
            provider,
            authType,
            credentialsEncrypted: this.encryption.encrypt(JSON.stringify(credentials)),
            baseUrl: dto.baseUrl,
            healthCheckPath: dto.healthCheckPath,
            apiKey: undefined,
        }, { upsert: true });
        this.triggerCrmSyncIfApplicable(organizationId, provider);
        return { connected: true, authType, baseUrl: dto.baseUrl };
    }
    connectFromDto(organizationId, provider, dto) {
        if (dto.authType)
            return this.connectWithAuth(organizationId, provider, dto);
        return this.connect(organizationId, provider, dto.apiKey, dto.baseUrl);
    }
    async verifyPlatformProvider(provider) {
        const token = this.jwt.sign({ sub: 'platform-admin' }, { expiresIn: '5m' });
        try {
            const { data } = await (0, rxjs_1.firstValueFrom)(this.http.post(`${this.pythonAgentUrl}/admin/providers/${provider}/verify`, {}, { headers: { Authorization: `Bearer ${token}` } }));
            return data;
        }
        catch (err) {
            this.logger.error(`Provider verification failed for ${provider}: ${err.message}`);
            return { ok: false, message: 'Could not reach the AI service to verify this connection. Please try again.' };
        }
    }
    async status(organizationId, provider) {
        this.assertAllowed(provider);
        const doc = await this.credentialModel.findOne({ organizationId, provider });
        if (!doc)
            return { connected: false };
        if (doc.authType) {
            return { connected: true, authType: doc.authType, baseUrl: doc.baseUrl };
        }
        return { connected: true, maskedKey: this.mask(this.decryptStoredApiKey(doc.apiKey)), baseUrl: doc.baseUrl };
    }
    async listCustom(organizationId) {
        const docs = await this.credentialModel
            .find({ organizationId, provider: { $nin: ['anthropic', 'crm'] } })
            .sort({ createdAt: -1 });
        return docs.map((doc) => ({
            provider: doc.provider,
            label: (0, provider_rules_1.getProviderRule)(doc.provider).label,
            connected: true,
            authType: doc.authType,
            maskedKey: doc.authType ? undefined : this.mask(this.decryptStoredApiKey(doc.apiKey)),
            baseUrl: doc.baseUrl,
            connectedAt: doc.createdAt,
        }));
    }
    async disconnect(organizationId, provider) {
        this.assertAllowed(provider);
        await this.credentialModel.deleteOne({ organizationId, provider });
    }
    async testConnection(organizationId, provider, dto) {
        let baseUrl = dto.baseUrl;
        let healthCheckPath = dto.healthCheckPath;
        let authType = dto.authType;
        let credentials = dto.credentials;
        if (!authType && !dto.apiKey) {
            const doc = await this.credentialModel.findOne({ organizationId, provider });
            if (!doc)
                return { ok: false, message: 'Nothing connected yet for this provider.' };
            baseUrl = baseUrl ?? doc.baseUrl;
            healthCheckPath = healthCheckPath ?? doc.healthCheckPath;
            if (doc.authType) {
                authType = doc.authType;
                credentials = JSON.parse(this.encryption.decrypt(doc.credentialsEncrypted));
            }
            else {
                authType = 'apiKeyBaseUrl';
                credentials = { apiKey: this.decryptStoredApiKey(doc.apiKey) };
            }
        }
        else if (!authType) {
            authType = 'apiKeyBaseUrl';
            credentials = { apiKey: dto.apiKey };
        }
        if (!baseUrl) {
            return { ok: false, message: 'A base URL is required to test the connection.' };
        }
        const url = healthCheckPath ? `${baseUrl.replace(/\/$/, '')}/${healthCheckPath.replace(/^\//, '')}` : baseUrl;
        try {
            await (0, ssrf_guard_1.assertPublicHttpUrl)(url);
        }
        catch (err) {
            return { ok: false, message: err.message };
        }
        const headers = (0, auth_methods_1.buildAuthHeaders)(authType, credentials ?? {});
        try {
            const response = await (0, rxjs_1.firstValueFrom)(this.http.get(url, { headers, timeout: 10_000 }));
            return { ok: true, message: `Connected — received HTTP ${response.status}.` };
        }
        catch (err) {
            return { ok: false, message: this.friendlyErrorMessage(err) };
        }
    }
    async resolveAuth(organizationId, provider) {
        const doc = await this.credentialModel.findOne({ organizationId, provider });
        if (!doc)
            return null;
        if (doc.authType) {
            return {
                integrationId: doc._id,
                authType: doc.authType,
                credentials: JSON.parse(this.encryption.decrypt(doc.credentialsEncrypted)),
                baseUrl: doc.baseUrl,
            };
        }
        return {
            integrationId: doc._id,
            authType: 'apiKeyBaseUrl',
            credentials: { apiKey: this.decryptStoredApiKey(doc.apiKey) },
            baseUrl: doc.baseUrl,
        };
    }
    async listConnected(organizationId) {
        const docs = await this.credentialModel.find({ organizationId }, { provider: 1 });
        return docs.map((doc) => ({ integrationId: doc._id, provider: doc.provider }));
    }
    friendlyErrorMessage(err) {
        const axiosErr = err;
        const status = axiosErr.response?.status;
        if (status === 401)
            return 'The provider rejected these credentials (401 Unauthorized).';
        if (status === 403)
            return 'These credentials don\'t have permission to access this resource (403 Forbidden).';
        if (status === 404)
            return 'Reached the server, but that URL/endpoint was not found (404).';
        if (status && status >= 500)
            return `The provider's server had an error (HTTP ${status}).`;
        if (axiosErr.code === 'ECONNABORTED')
            return 'The connection timed out — check the base URL.';
        if (axiosErr.code === 'ENOTFOUND' || axiosErr.code === 'ECONNREFUSED') {
            return "Couldn't reach that URL — check it's correct and publicly reachable.";
        }
        return 'Could not connect — please check the URL and credentials.';
    }
    getProviderRule(provider) {
        return (0, provider_rules_1.getProviderRule)(provider);
    }
    assertAllowed(provider, authType) {
        if (!PROVIDER_SLUG.test(provider)) {
            throw new common_1.BadRequestException('Provider name must be alphanumeric (dashes/underscores allowed).');
        }
        const rule = (0, provider_rules_1.getProviderRule)(provider);
        if (rule.dedicatedFlowPath) {
            throw new common_1.BadRequestException(rule.note ?? `"${provider}" has its own dedicated connect flow.`);
        }
        if (authType && !rule.allowedAuthTypes.includes(authType)) {
            throw new common_1.BadRequestException(rule.note ??
                `${rule.label} only supports: ${rule.allowedAuthTypes.join(', ') || 'a dedicated flow not yet built here'}.`);
        }
    }
    mask(apiKey) {
        return apiKey.length > 12 ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}` : '***';
    }
    decryptStoredApiKey(value) {
        if (!value)
            return '';
        try {
            return this.encryption.decrypt(value);
        }
        catch {
            return value;
        }
    }
};
exports.IntegrationsService = IntegrationsService;
exports.IntegrationsService = IntegrationsService = IntegrationsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, mongoose_1.InjectModel)(integration_credential_schema_1.IntegrationCredential.name)),
    __metadata("design:paramtypes", [mongoose_2.Model,
        encryption_service_1.EncryptionService,
        axios_1.HttpService,
        jwt_1.JwtService,
        config_1.ConfigService])
], IntegrationsService);
//# sourceMappingURL=integrations.service.js.map