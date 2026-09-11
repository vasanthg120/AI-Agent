import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Model, Types } from 'mongoose';
import { EncryptionService } from '../common/encryption/encryption.service';
import { AuthCredentials, AuthType } from './auth-methods';
import { ConnectIntegrationDto } from './dto/connect-integration.dto';
import { TestConnectionDto } from './dto/test-connection.dto';
import { ProviderRule } from './provider-rules';
import { IntegrationCredentialDocument } from './schemas/integration-credential.schema';
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
    private readonly logger;
    private readonly pythonAgentUrl;
    constructor(credentialModel: Model<IntegrationCredentialDocument>, encryption: EncryptionService, http: HttpService, jwt: JwtService, config: ConfigService);
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
    connectWithAuth(organizationId: string, provider: string, dto: ConnectIntegrationDto): Promise<{
        connected: true;
        authType: AuthType;
        baseUrl?: string;
    }>;
    connectFromDto(organizationId: string, provider: string, dto: ConnectIntegrationDto): Promise<{
        connected: true;
        maskedKey: string;
        baseUrl?: string;
    }> | Promise<{
        connected: true;
        authType: AuthType;
        baseUrl?: string;
    }>;
    verifyPlatformProvider(provider: 'anthropic' | 'sarvam' | 'groq'): Promise<{
        ok: boolean;
        message: string;
    }>;
    status(organizationId: string, provider: string): Promise<IntegrationStatus>;
    listCustom(organizationId: string): Promise<IntegrationSummary[]>;
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
