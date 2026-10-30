import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { EncryptionService } from '../common/encryption/encryption.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { UsersService } from '../users/users.service';
import { OutlookConnectionDocument } from './schemas/outlook-connection.schema';
import { MicrosoftTenantAuthorizationDocument } from './schemas/microsoft-tenant-authorization.schema';
export interface OutlookAccountSummary {
    email: string;
    isActive: boolean;
    connectedAt: Date;
    status: 'connected' | 'needs_reauth';
    handledByUserId?: string;
}
export interface OutlookOrgAccountSummary extends OutlookAccountSummary {
    ownerUserId: string;
    ownerName: string;
    ownerEmail: string;
}
export declare function isAdminConsentRequiredError(errorDescription?: string): boolean;
export declare class OutlookService {
    private config;
    private http;
    private encryption;
    private usersService;
    private integrations;
    private connectionModel;
    private tenantAuthModel;
    constructor(config: ConfigService, http: HttpService, encryption: EncryptionService, usersService: UsersService, integrations: IntegrationsService, connectionModel: Model<OutlookConnectionDocument>, tenantAuthModel: Model<MicrosoftTenantAuthorizationDocument>);
    private get configured();
    private resolveAppCredentials;
    getEmails(): Promise<{
        id: string;
        from: string;
        subject: string;
        receivedAt: string;
    }[]>;
    getCalendarEvents(): Promise<never[]>;
    getContacts(): Promise<never[]>;
    private placeholderEmails;
    buildAuthorizeUrl(state: string): Promise<string>;
    buildAdminConsentUrl(state: string): Promise<string>;
    recordTenantAuthorization(tenantId: string, organizationId: string, userId: string, userEmail: string): Promise<void>;
    getTenantAuthorizationStatus(organizationId: string): Promise<{
        authorized: boolean;
        tenantId?: string;
        authorizedByEmail?: string;
    }>;
    handleCallback(code: string, userId: string, organizationId?: string): Promise<{
        email: string;
    }>;
    private decodeAccessTokenClaims;
    getStatus(userId: string): Promise<{
        connected: boolean;
        email?: string;
        canSend: boolean;
    }>;
    setHandler(userId: string, organizationId: string, email: string, handlerUserId: string | null): Promise<OutlookAccountSummary[]>;
    listAccounts(userId: string): Promise<OutlookAccountSummary[]>;
    listOrgAccounts(organizationId: string): Promise<OutlookOrgAccountSummary[]>;
    setActive(userId: string, email: string): Promise<void>;
    disconnect(userId: string, email: string): Promise<void>;
    private tokenEndpoint;
    private exchangeCode;
    private fetchUserEmail;
}
