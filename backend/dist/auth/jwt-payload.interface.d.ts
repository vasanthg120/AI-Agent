export interface JwtPayload {
    sub: string;
    loginUserId?: string;
    isSubAccount?: boolean;
    exp?: number;
    email: string;
    roles: string[];
    organizationId: string;
    storeId?: string;
    assignedAgentId?: string;
    features?: string[];
    department?: string;
    voiceAccessEnabled?: boolean;
    aiAccessEnabled?: boolean;
    jti?: string;
    authMethod?: 'session' | 'api_token' | 'service';
    purpose?: string;
}
export declare function loginIdOf(user: Pick<JwtPayload, 'sub' | 'loginUserId'>): string;
