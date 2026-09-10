import { JwtPayload } from '../auth/jwt-payload.interface';
import { ConnectIntegrationDto } from './dto/connect-integration.dto';
import { TestConnectionDto } from './dto/test-connection.dto';
import { IntegrationsService } from './integrations.service';
export declare class IntegrationsController {
    private integrationsService;
    constructor(integrationsService: IntegrationsService);
    listCustom(user: JwtPayload): Promise<import("./integrations.service").IntegrationSummary[]>;
    getProviderRule(provider: string): import("./provider-rules").ProviderRule;
    syncCrmNow(user: JwtPayload): Promise<{
        dealsSynced: number;
        quotesSynced: number;
    }>;
    connect(user: JwtPayload, provider: string, dto: ConnectIntegrationDto): Promise<{
        connected: true;
        maskedKey: string;
        baseUrl?: string;
    }> | Promise<{
        connected: true;
        authType: import("./auth-methods").AuthType;
        baseUrl?: string;
    }>;
    testConnection(user: JwtPayload, provider: string, dto: TestConnectionDto): Promise<{
        ok: boolean;
        message: string;
    }>;
    status(user: JwtPayload, provider: string): Promise<import("./integrations.service").IntegrationStatus>;
    disconnect(user: JwtPayload, provider: string): Promise<void>;
}
