import { HttpService } from '@nestjs/axios';
import { DataSourcesService } from '../data-sources/data-sources.service';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Model, Types } from 'mongoose';
import { EncryptionService } from '../common/encryption/encryption.service';
import { AuthCredentials, AuthType } from './auth-methods';
import { ConnectIntegrationDto } from './dto/connect-integration.dto';
import { TestConnectionDto } from './dto/test-connection.dto';
import { ProviderRule } from './provider-rules';
import { IntegrationCredentialDocument } from './schemas/integration-credential.schema';
export declare const PLATFORM_PROVIDERS: readonly ["anthropic", "sarvam", "elevenlabs", "groq"];
export type PlatformProvider = (typeof PLATFORM_PROVIDERS)[number];
export interface IntegrationStatus {
    connected: boolean;
    authType?: AuthType;
    maskedKey?: string;
    baseUrl?: string;
}
export interface IntegrationSummary extends IntegrationStatus {
    provider: string;
    label: string;
    connectedAt?: Date;
}
export declare class IntegrationsService {
    private credentialModel;
    private encryption;
    private http;
    private jwt;
    private config;
    private dataSources;
    private readonly logger;
    private readonly pythonAgentUrl;
    constructor(credentialModel: Model<IntegrationCredentialDocument>, encryption: EncryptionService, http: HttpService, jwt: JwtService, config: ConfigService, dataSources: DataSourcesService);
    syncCrmNow(organizationId: string): Promise<{
        dealsSynced: number;
        quotesSynced: number;
    }>;
    private triggerCrmSyncIfApplicable;
    connect(organizationId: string, provider: string, apiKey: string, baseUrl?: string): Promise<{
        connected: true;
        maskedKey: string;
        baseUrl?: string;
    }>;
    connectWithAuth(organizationId: string, provider: string, dto: ConnectIntegrationDto, options?: {
        skipSync?: boolean;
    }): Promise<{
        connected: true;
        authType: AuthType;
        baseUrl?: string;
    }>;
    connectWithOAuth(organizationId: string, provider: string, tokens: {
        accessToken: string;
        refreshToken: string;
        expiresInSeconds: number;
        oauthMeta?: Record<string, string>;
        baseUrl?: string;
    }, options?: {
        skipSync?: boolean;
    }): Promise<{
        connected: true;
    }>;
    saveOAuthAppCredentials(organizationId: string, provider: string, app: {
        clientId: string;
        clientSecret: string;
        meta?: Record<string, string>;
    }): Promise<void>;
    getOAuthAppCredentialsStatus(organizationId: string, provider: string): Promise<{
        configured: boolean;
        clientId?: string;
        clientSecretMasked?: string;
        meta?: Record<string, string>;
    }>;
    resolveOAuthAppCredentials(organizationId: string, provider: string): Promise<{
        clientId: string;
        clientSecret: string;
        meta?: Record<string, string>;
    } | null>;
    private refreshOAuthToken;
    connectFromDto(organizationId: string, provider: string, dto: ConnectIntegrationDto): Promise<{
        connected: true;
        maskedKey: string;
        baseUrl?: string;
    }> | Promise<{
        connected: true;
        authType: AuthType;
        baseUrl?: string;
    }>;
    verifyPlatformProvider(provider: PlatformProvider): Promise<{
        ok: boolean;
        message: string;
    }>;
    status(organizationId: string, provider: string): Promise<IntegrationStatus>;
    listCustom(organizationId: string): Promise<IntegrationSummary[]>;
    mergeOAuthMeta(organizationId: string, provider: string, patch: Record<string, string>): Promise<void>;
    saveSecondaryCredentials(organizationId: string, provider: string, creds: {
        username: string;
        password: string;
    }): Promise<void>;
    disconnect(organizationId: string, provider: string): Promise<void>;
    testConnection(organizationId: string, provider: string, dto: TestConnectionDto): Promise<{
        ok: boolean;
        message: string;
    }>;
    resolveAuth(organizationId: string, provider: string): Promise<{
        integrationId: Types.ObjectId;
        authType: AuthType;
        credentials: AuthCredentials;
        baseUrl?: string;
        oauthMeta?: Record<string, string>;
        secondaryCredentials?: {
            username: string;
            password: string;
        };
    } | null>;
    listConnected(organizationId: string): Promise<{
        integrationId: Types.ObjectId;
        provider: string;
    }[]>;
    private friendlyErrorMessage;
    getProviderRule(provider: string): ProviderRule;
    private assertAllowed;
    private mask;
    private decryptStoredApiKey;
}
