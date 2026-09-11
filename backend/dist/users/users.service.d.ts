import { Model } from 'mongoose';
import { AgentRoleDocument } from '../agent-roles/schemas/agent-role.schema';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { PushSubscriptionEntry, SessionEntry, TwoFactorBackupCode, User, UserDocument } from './schemas/user.schema';
export declare class UsersService {
    private userModel;
    private agentRoleModel;
    constructor(userModel: Model<UserDocument>, agentRoleModel: Model<AgentRoleDocument>);
    findByEmail(email: string): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<import("mongoose").Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    findById(id: string): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<import("mongoose").Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    findIdsByOrgAndStore(organizationId: string, storeId: string): Promise<string[]>;
    findAll(organizationId: string): Promise<UserDocument[]>;
    create(data: {
        email: string;
        passwordHash?: string;
        name: string;
        organizationId: string;
        storeId?: string;
        roles?: string[];
    }): Promise<import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<import("mongoose").Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }>;
    findByOAuthId(provider: 'google' | 'microsoft' | 'github', providerId: string): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<import("mongoose").Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    linkOAuthProvider(userId: string, provider: 'google' | 'microsoft' | 'github', providerId: string): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<import("mongoose").Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    createByAdmin(dto: CreateUserDto, organizationId: string): Promise<{
        user: {
            id: string;
            email: string;
            name: string;
            organizationId: string;
            storeId: string | undefined;
            roles: string[];
            assignedAgentId: string | undefined;
            department: string | undefined;
            active: boolean;
            voiceAccessEnabled: boolean;
        };
        tempPassword: string;
    }>;
    updateByAdmin(id: string, dto: UpdateUserDto, organizationId: string): Promise<{
        id: string;
        email: string;
        name: string;
        organizationId: string;
        storeId: string | undefined;
        roles: string[];
        assignedAgentId: string | undefined;
        department: string | undefined;
        active: boolean;
        voiceAccessEnabled: boolean;
    }>;
    deleteByAdmin(id: string, organizationId: string): Promise<void>;
    private assertNotOwner;
    toPublic(user: UserDocument): {
        id: string;
        email: string;
        name: string;
        organizationId: string;
        storeId: string | undefined;
        roles: string[];
        assignedAgentId: string | undefined;
        department: string | undefined;
        active: boolean;
        voiceAccessEnabled: boolean;
    };
    setVerifyOtp(userId: string, otpHash: string, expiresAt: Date): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<import("mongoose").Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    markEmailVerified(userId: string): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<import("mongoose").Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    setResetOtp(userId: string, otpHash: string, expiresAt: Date): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<import("mongoose").Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    resetPassword(userId: string, passwordHash: string): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<import("mongoose").Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    addSession(userId: string, entry: SessionEntry): Promise<void>;
    touchSessionIfStale(userId: string, jti: string): Promise<unknown>;
    revokeSession(userId: string, jti: string): Promise<import("mongoose").UpdateWriteOpResult>;
    revokeAllOtherSessions(userId: string, keepJti: string): Promise<string[]>;
    addOrReplacePushSubscription(userId: string, entry: PushSubscriptionEntry): Promise<void>;
    removePushSubscription(userId: string, endpoint: string): Promise<import("mongoose").UpdateWriteOpResult>;
    updateNotificationPreferences(userId: string, patch: Partial<{
        desktopPush: boolean;
        mobilePush: boolean;
        email: boolean;
    }>): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<import("mongoose").Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    setPendingTwoFactorSecret(userId: string, secretEncrypted: string, expiresAt: Date): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<import("mongoose").Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    confirmTwoFactor(userId: string, secretEncrypted: string, backupCodes: TwoFactorBackupCode[]): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<import("mongoose").Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    clearTwoFactor(userId: string): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<import("mongoose").Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    setBackupCodes(userId: string, backupCodes: TwoFactorBackupCode[]): Promise<(import("mongoose").Document<unknown, {}, UserDocument, {}, {}> & User & import("mongoose").Document<import("mongoose").Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    }) | null>;
    markBackupCodeUsed(userId: string, codeHash: string): Promise<import("mongoose").UpdateWriteOpResult>;
    private resolveValidAgentIds;
}
