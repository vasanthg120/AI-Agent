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
exports.IntegrationsService = exports.PLATFORM_PROVIDERS = void 0;
const axios_1 = require("@nestjs/axios");
const data_sources_service_1 = require("../data-sources/data-sources.service");
const provider_catalog_1 = require("../data-sources/provider-catalog");
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
const PROVIDER_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
exports.PLATFORM_PROVIDERS = ['anthropic', 'sarvam', 'elevenlabs', 'groq'];
let IntegrationsService = IntegrationsService_1 = class IntegrationsService {
    constructor(credentialModel, encryption, http, jwt, config, dataSources) {
        this.credentialModel = credentialModel;
        this.encryption = encryption;
        this.http = http;
        this.jwt = jwt;
        this.config = config;
        this.dataSources = dataSources;
        this.logger = new common_1.Logger(IntegrationsService_1.name);
        this.pythonAgentUrl = this.config.get('pythonAgentUrl') ?? 'http://localhost:8000';
    }
    async syncCrmNow(organizationId) {
        const token = this.jwt.sign({ sub: 'system', organizationId }, { expiresIn: '10m' });
        const { data } = await (0, rxjs_1.firstValueFrom)(this.http.post(`${this.pythonAgentUrl}/sync/crm/run-for-org`, {}, { headers: { Authorization: `Bearer ${token}` }, timeout: 180_000 }));
        return data;
    }
    triggerCrmSyncIfApplicable(organizationId, provider) {
        if (!(0, provider_catalog_1.crmProviderForIntegration)(provider))
            return;
        this.dataSources
            .reconcile(organizationId)
            .then(() => this.syncCrmNow(organizationId))
            .catch((err) => {
            this.logger.error(`Immediate CRM sync failed for org ${organizationId}: ${err.message}`);
        });
    }
    async connect(organizationId, provider, apiKey, baseUrl) {
        this.assertAllowed(provider);
        await this.credentialModel.findOneAndUpdate({ organizationId, provider }, { organizationId, provider, apiKey: this.encryption.encrypt(apiKey), baseUrl, authType: undefined, credentialsEncrypted: undefined }, { upsert: true });
        this.triggerCrmSyncIfApplicable(organizationId, provider);
        return { connected: true, maskedKey: this.mask(apiKey), baseUrl };
    }
    async connectWithAuth(organizationId, provider, dto, options = {}) {
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
        if (options.skipSync) {
            if ((0, provider_catalog_1.crmProviderForIntegration)(provider))
                await this.dataSources.reconcile(organizationId);
        }
        else {
            this.triggerCrmSyncIfApplicable(organizationId, provider);
        }
        return { connected: true, authType, baseUrl: dto.baseUrl };
    }
    async connectWithOAuth(organizationId, provider, tokens, options = {}) {
        this.assertAllowed(provider, 'oauth2');
        await this.credentialModel.findOneAndUpdate({ organizationId, provider }, {
            organizationId,
            provider,
            authType: 'oauth2',
            credentialsEncrypted: this.encryption.encrypt(JSON.stringify({ accessToken: tokens.accessToken })),
            refreshTokenEncrypted: this.encryption.encrypt(tokens.refreshToken),
            tokenExpiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
            oauthMeta: tokens.oauthMeta,
            baseUrl: tokens.baseUrl,
            status: 'connected',
            apiKey: undefined,
        }, { upsert: true });
        if (options.skipSync) {
            if ((0, provider_catalog_1.crmProviderForIntegration)(provider))
                await this.dataSources.reconcile(organizationId);
        }
        else {
            this.triggerCrmSyncIfApplicable(organizationId, provider);
        }
        return { connected: true };
    }
    async saveOAuthAppCredentials(organizationId, provider, app) {
        await this.credentialModel.findOneAndUpdate({ organizationId, provider }, {
            $set: {
                organizationId,
                provider,
                oauthClientId: app.clientId,
                oauthClientSecretEncrypted: this.encryption.encrypt(app.clientSecret),
                ...(app.meta ? { oauthMeta: app.meta } : {}),
            },
        }, { upsert: true });
    }
    async getOAuthAppCredentialsStatus(organizationId, provider) {
        const doc = await this.credentialModel.findOne({ organizationId, provider }, { oauthClientId: 1, oauthClientSecretEncrypted: 1, oauthMeta: 1 });
        if (!doc?.oauthClientId || !doc?.oauthClientSecretEncrypted)
            return { configured: false };
        return { configured: true, clientId: doc.oauthClientId, clientSecretMasked: '••••••••••••', meta: doc.oauthMeta };
    }
    async resolveOAuthAppCredentials(organizationId, provider) {
        const doc = await this.credentialModel.findOne({ organizationId, provider }, { oauthClientId: 1, oauthClientSecretEncrypted: 1, oauthMeta: 1 });
        if (!doc?.oauthClientId || !doc?.oauthClientSecretEncrypted)
            return null;
        return { clientId: doc.oauthClientId, clientSecret: this.encryption.decrypt(doc.oauthClientSecretEncrypted), meta: doc.oauthMeta };
    }
    async refreshOAuthToken(doc) {
        const EXPIRY_BUFFER_MS = 60_000;
        if (doc.tokenExpiresAt && doc.tokenExpiresAt.getTime() > Date.now() + EXPIRY_BUFFER_MS) {
            const current = JSON.parse(this.encryption.decrypt(doc.credentialsEncrypted));
            return current.accessToken ?? null;
        }
        if (doc.status === 'needs_reauth' || !doc.refreshTokenEncrypted)
            return null;
        try {
            const refreshToken = this.encryption.decrypt(doc.refreshTokenEncrypted);
            const oauthMeta = doc.oauthMeta ?? {};
            let refreshed;
            if (doc.provider === 'zoho') {
                const base = oauthMeta.accountsServer || this.config.get('integrations.zoho.accountsBaseUrl') || 'https://accounts.zoho.com';
                const clientId = doc.oauthClientId || this.config.get('integrations.zoho.clientId') || '';
                const clientSecret = doc.oauthClientSecretEncrypted
                    ? this.encryption.decrypt(doc.oauthClientSecretEncrypted)
                    : this.config.get('integrations.zoho.clientSecret') || '';
                const { data } = await (0, rxjs_1.firstValueFrom)(this.http.post(`${base.replace(/\/$/, '')}/oauth/v2/token`, new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                    client_id: clientId,
                    client_secret: clientSecret,
                }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }));
                if (!data.access_token)
                    throw new Error(data.error ?? 'Zoho did not return an access token');
                refreshed = {
                    accessToken: data.access_token,
                    expiresInSeconds: data.expires_in ?? 3600,
                    oauthMeta: { ...oauthMeta, apiDomain: data.api_domain ?? oauthMeta.apiDomain ?? '' },
                };
            }
            else if (doc.provider === 'zohobooks') {
                const base = oauthMeta.accountsServer || this.config.get('integrations.zohobooks.accountsBaseUrl') || 'https://accounts.zoho.com';
                const clientId = doc.oauthClientId || this.config.get('integrations.zohobooks.clientId') || '';
                const clientSecret = doc.oauthClientSecretEncrypted
                    ? this.encryption.decrypt(doc.oauthClientSecretEncrypted)
                    : this.config.get('integrations.zohobooks.clientSecret') || '';
                const { data } = await (0, rxjs_1.firstValueFrom)(this.http.post(`${base.replace(/\/$/, '')}/oauth/v2/token`, new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                    client_id: clientId,
                    client_secret: clientSecret,
                }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }));
                if (!data.access_token)
                    throw new Error(data.error ?? 'Zoho Books did not return an access token');
                refreshed = {
                    accessToken: data.access_token,
                    expiresInSeconds: data.expires_in ?? 3600,
                    oauthMeta: { ...oauthMeta, booksApiDomain: data.api_domain ?? oauthMeta.booksApiDomain ?? '' },
                };
            }
            else if (doc.provider === 'zohopayroll') {
                const base = oauthMeta.accountsServer || this.config.get('integrations.zohopayroll.accountsBaseUrl') || 'https://accounts.zoho.com';
                const clientId = doc.oauthClientId || this.config.get('integrations.zohopayroll.clientId') || '';
                const clientSecret = doc.oauthClientSecretEncrypted
                    ? this.encryption.decrypt(doc.oauthClientSecretEncrypted)
                    : this.config.get('integrations.zohopayroll.clientSecret') || '';
                const { data } = await (0, rxjs_1.firstValueFrom)(this.http.post(`${base.replace(/\/$/, '')}/oauth/v2/token`, new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                    client_id: clientId,
                    client_secret: clientSecret,
                }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }));
                if (!data.access_token)
                    throw new Error(data.error ?? 'Zoho Payroll did not return an access token');
                refreshed = {
                    accessToken: data.access_token,
                    expiresInSeconds: data.expires_in ?? 3600,
                    oauthMeta: { ...oauthMeta, payrollApiDomain: data.api_domain ?? oauthMeta.payrollApiDomain ?? '' },
                };
            }
            else if (doc.provider === 'salesforce') {
                const base = oauthMeta.authBaseUrl || this.config.get('integrations.salesforce.authBaseUrl') || 'https://login.salesforce.com';
                const { data } = await (0, rxjs_1.firstValueFrom)(this.http.post(`${base.replace(/\/$/, '')}/services/oauth2/token`, new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                    client_id: this.config.get('integrations.salesforce.clientId') ?? '',
                    client_secret: this.config.get('integrations.salesforce.clientSecret') ?? '',
                }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }));
                if (!data.access_token)
                    throw new Error(data.error_description ?? data.error ?? 'Salesforce did not return an access token');
                refreshed = {
                    accessToken: data.access_token,
                    expiresInSeconds: 7200,
                    oauthMeta: { ...oauthMeta, instanceUrl: data.instance_url ?? oauthMeta.instanceUrl ?? '' },
                };
            }
            else if (doc.provider === 'xero') {
                const saved = await this.resolveOAuthAppCredentials('platform', 'xero');
                const clientId = saved?.clientId || this.config.get('integrations.xero.clientId') || '';
                const clientSecret = saved?.clientSecret || this.config.get('integrations.xero.clientSecret') || '';
                const { data } = await (0, rxjs_1.firstValueFrom)(this.http.post('https://identity.xero.com/connect/token', new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                    client_id: clientId,
                    client_secret: clientSecret,
                }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }));
                if (!data.access_token)
                    throw new Error(data.error ?? 'Xero did not return an access token');
                refreshed = {
                    accessToken: data.access_token,
                    refreshToken: data.refresh_token,
                    expiresInSeconds: data.expires_in ?? 1800,
                    oauthMeta,
                };
            }
            else if (doc.provider === 'myob') {
                const saved = await this.resolveOAuthAppCredentials('platform', 'myob');
                const clientId = saved?.clientId || this.config.get('integrations.myob.clientId') || '';
                const clientSecret = saved?.clientSecret || this.config.get('integrations.myob.clientSecret') || '';
                const { data } = await (0, rxjs_1.firstValueFrom)(this.http.post('https://secure.myob.com/oauth2/v1/authorize', new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                    client_id: clientId,
                    client_secret: clientSecret,
                }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }));
                if (!data.access_token)
                    throw new Error(data.error ?? 'MYOB did not return an access token');
                refreshed = { accessToken: data.access_token, expiresInSeconds: data.expires_in ?? 1200, oauthMeta };
            }
            else {
                return null;
            }
            await this.credentialModel.updateOne({ _id: doc._id }, {
                $set: {
                    credentialsEncrypted: this.encryption.encrypt(JSON.stringify({ accessToken: refreshed.accessToken })),
                    tokenExpiresAt: new Date(Date.now() + refreshed.expiresInSeconds * 1000),
                    oauthMeta: refreshed.oauthMeta,
                    ...(refreshed.refreshToken ? { refreshTokenEncrypted: this.encryption.encrypt(refreshed.refreshToken) } : {}),
                },
            });
            return refreshed.accessToken;
        }
        catch (err) {
            this.logger.warn(`OAuth refresh failed for provider=${doc.provider} org=${doc.organizationId} — marking needs_reauth: ${err.message}`);
            await this.credentialModel.updateOne({ _id: doc._id }, { $set: { status: 'needs_reauth' } });
            return null;
        }
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
        const docs = await this.credentialModel.find({ organizationId, provider: { $nin: ['anthropic', 'crm'] } }).sort({ createdAt: -1 });
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
    async mergeOAuthMeta(organizationId, provider, patch) {
        const sets = {};
        for (const [key, value] of Object.entries(patch))
            sets[`oauthMeta.${key}`] = value;
        await this.credentialModel.updateOne({ organizationId, provider }, { $set: sets });
    }
    async saveSecondaryCredentials(organizationId, provider, creds) {
        await this.credentialModel.updateOne({ organizationId, provider }, { $set: { secondaryCredentialsEncrypted: this.encryption.encrypt(JSON.stringify(creds)) } });
    }
    async disconnect(organizationId, provider) {
        this.assertAllowed(provider);
        await this.credentialModel.deleteOne({ organizationId, provider });
        if ((0, provider_catalog_1.crmProviderForIntegration)(provider))
            await this.dataSources.reconcile(organizationId);
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
        if (doc.authType === 'oauth2') {
            const accessToken = await this.refreshOAuthToken(doc);
            return {
                integrationId: doc._id,
                authType: doc.authType,
                credentials: { accessToken: accessToken ?? undefined },
                baseUrl: doc.oauthMeta?.apiDomain ||
                    doc.oauthMeta?.instanceUrl ||
                    (doc.oauthMeta?.booksApiDomain ? `${doc.oauthMeta.booksApiDomain.replace(/\/$/, '')}/books/v3` : undefined) ||
                    (doc.oauthMeta?.payrollApiDomain ? `${doc.oauthMeta.payrollApiDomain.replace(/\/$/, '')}/payroll/v1` : undefined) ||
                    doc.baseUrl,
                oauthMeta: doc.oauthMeta,
                secondaryCredentials: doc.secondaryCredentialsEncrypted
                    ? JSON.parse(this.encryption.decrypt(doc.secondaryCredentialsEncrypted))
                    : undefined,
            };
        }
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
            return "These credentials don't have permission to access this resource (403 Forbidden).";
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
            throw new common_1.BadRequestException(rule.note ?? `${rule.label} only supports: ${rule.allowedAuthTypes.join(', ') || 'a dedicated flow not yet built here'}.`);
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
        config_1.ConfigService,
        data_sources_service_1.DataSourcesService])
], IntegrationsService);
//# sourceMappingURL=integrations.service.js.map