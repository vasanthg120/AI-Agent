import { Document, Types } from 'mongoose';
export type OutlookConnectionDocument = OutlookConnection & Document<Types.ObjectId>;
export declare class OutlookConnection {
    userId: string;
    organizationId?: string;
    email: string;
    addresses?: string[];
    microsoftTenantId?: string;
    microsoftUserId?: string;
    handledByUserId?: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    scope: string;
    isActive: boolean;
    status?: 'connected' | 'needs_reauth';
}
export declare const OutlookConnectionSchema: import("mongoose").Schema<OutlookConnection, import("mongoose").Model<OutlookConnection, any, any, any, Document<unknown, any, OutlookConnection, any, {}> & OutlookConnection & {
    _id: Types.ObjectId;
} & {
    __v: number;
}, any>, {}, {}, {}, {}, import("mongoose").DefaultSchemaOptions, OutlookConnection, Document<unknown, {}, import("mongoose").FlatRecord<OutlookConnection>, {}, import("mongoose").DefaultSchemaOptions> & import("mongoose").FlatRecord<OutlookConnection> & {
    _id: Types.ObjectId;
} & {
    __v: number;
}>;
