import { Document, Types } from 'mongoose';
export type UserDocument = User & Document<Types.ObjectId>;
export declare class SessionEntry {
    jti: string;
    device: string;
    userAgent?: string;
    ip?: string;
    location?: string;
    createdAt: Date;
    lastSeenAt: Date;
}
export declare class PushSubscriptionEntry {
    endpoint: string;
    keys: {
        p256dh: string;
        auth: string;
    };
    deviceType: 'desktop' | 'mobile';
    userAgent?: string;
    createdAt: Date;
}
export declare class TwoFactorBackupCode {
    codeHash: string;
    usedAt?: Date;
}
export declare class User {
    email: string;
    passwordHash?: string;
    name: string;
    organizationId: string;
    storeId?: string;
    roles: string[];
    assignedAgentId?: string;
    department?: string;
    active: boolean;
    voiceAccessEnabled: boolean;
    preferences: Record<string, unknown>;
    emailVerified: boolean;
    verifyOtpHash?: string;
    verifyOtpExpiresAt?: Date;
    resetOtpHash?: string;
    resetOtpExpiresAt?: Date;
    oauthProviders: {
        google?: string;
        microsoft?: string;
        github?: string;
    };
    twoFactorEnabled: boolean;
    twoFactorSecretEncrypted?: string;
    twoFactorEnabledAt?: Date;
    twoFactorPendingSecretEncrypted?: string;
    twoFactorPendingSecretExpiresAt?: Date;
    twoFactorBackupCodes: TwoFactorBackupCode[];
    sessions: SessionEntry[];
    pushSubscriptions: PushSubscriptionEntry[];
    notificationPreferences: {
        desktopPush: boolean;
        mobilePush: boolean;
        email: boolean;
    };
}
export declare const UserSchema: import("mongoose").Schema<User, import("mongoose").Model<User, any, any, any, Document<unknown, any, User, any, {}> & User & {
    _id: Types.ObjectId;
} & {
    __v: number;
}, any>, {}, {}, {}, {}, import("mongoose").DefaultSchemaOptions, User, Document<unknown, {}, import("mongoose").FlatRecord<User>, {}, import("mongoose").DefaultSchemaOptions> & import("mongoose").FlatRecord<User> & {
    _id: Types.ObjectId;
} & {
    __v: number;
}>;
