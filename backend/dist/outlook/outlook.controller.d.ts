import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { CloudConnectionsService } from '../cloud-files/cloud-connections.service';
import { OutlookService } from './outlook.service';
export declare class OutlookController {
    private outlookService;
    private jwtService;
    private config;
    private cloudConnections;
    private readonly logger;
    constructor(outlookService: OutlookService, jwtService: JwtService, config: ConfigService, cloudConnections: CloudConnectionsService);
    getEmails(): Promise<{
        id: string;
        from: string;
        subject: string;
        receivedAt: string;
    }[]>;
    getCalendarEvents(): Promise<never[]>;
    getContacts(): Promise<never[]>;
    getConnectUrl(user: JwtPayload): {
        url: string;
    };
    callback(code?: string, state?: string, error?: string, errorDescription?: string): Promise<{
        url: string;
        statusCode: number;
    }>;
    getAdminConsentUrl(user: JwtPayload): {
        url: string;
    };
    adminConsentCallback(tenant?: string, adminConsent?: string, state?: string, error?: string, errorDescription?: string): Promise<{
        url: string;
        statusCode: number;
    }>;
    getTenantAuthorizationStatus(user: JwtPayload): Promise<{
        authorized: boolean;
        tenantId?: string;
        authorizedByEmail?: string;
    }>;
    getStatus(user: JwtPayload): Promise<{
        connected: boolean;
        email?: string;
        canSend: boolean;
    }>;
    listAccounts(user: JwtPayload): Promise<import("./outlook.service").OutlookAccountSummary[]>;
    setActive(user: JwtPayload, email: string): Promise<void>;
    setHandler(user: JwtPayload, email: string, body: {
        userId?: string | null;
    }): Promise<import("./outlook.service").OutlookAccountSummary[]>;
    disconnectAccount(user: JwtPayload, email: string): Promise<void>;
    listOrgAccounts(user: JwtPayload): Promise<import("./outlook.service").OutlookOrgAccountSummary[]>;
}
