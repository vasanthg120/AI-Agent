import { Document, Types } from 'mongoose';
export type IntegrationCredentialDocument = IntegrationCredential & Document<Types.ObjectId>;
export declare class IntegrationCredential {
    organizationId: string;
    provider: string;
    apiKey?: string;
    baseUrl?: string;
    authType?: 'apiKey' | 'apiKeyBaseUrl' | 'bearer' | 'basic' | 'customHeaders';
    credentialsEncrypted?: string;
    healthCheckPath?: string;
    budgetUsd?: number;
    budgetPeriod?: 'monthly' | 'total';
}
export declare const IntegrationCredentialSchema: import("mongoose").Schema<IntegrationCredential, import("mongoose").Model<IntegrationCredential, any, any, any, Document<unknown, any, IntegrationCredential, any, {}> & IntegrationCredential & {
    _id: Types.ObjectId;
} & {
    __v: number;
}, any>, {}, {}, {}, {}, import("mongoose").DefaultSchemaOptions, IntegrationCredential, Document<unknown, {}, import("mongoose").FlatRecord<IntegrationCredential>, {}, import("mongoose").DefaultSchemaOptions> & import("mongoose").FlatRecord<IntegrationCredential> & {
    _id: Types.ObjectId;
} & {
    __v: number;
}>;
