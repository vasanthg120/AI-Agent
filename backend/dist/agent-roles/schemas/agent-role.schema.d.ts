import { Document, Types } from 'mongoose';
export type AgentRoleDocument = AgentRole & Document<Types.ObjectId>;
export declare const ROLE_CATEGORIES: readonly ["sales", "finance", "hr", "support", "marketing", "operations", "custom"];
export type RoleCategory = (typeof ROLE_CATEGORIES)[number];
export declare class AgentRole {
    organizationId: string;
    slug: string;
    name: string;
    department: string;
    description: string;
    systemPrompt: string;
    sourceDocumentName?: string;
    sourceDocumentId?: string;
    status: 'draft' | 'active';
    assignedDepartments: string[];
    assignedUserIds: string[];
    allowedTools: string[];
    modelTier?: 'fast' | 'standard';
    avatarColor: string;
    createdBy: string;
}
export declare const AgentRoleSchema: import("mongoose").Schema<AgentRole, import("mongoose").Model<AgentRole, any, any, any, Document<unknown, any, AgentRole, any, {}> & AgentRole & {
    _id: Types.ObjectId;
} & {
    __v: number;
}, any>, {}, {}, {}, {}, import("mongoose").DefaultSchemaOptions, AgentRole, Document<unknown, {}, import("mongoose").FlatRecord<AgentRole>, {}, import("mongoose").DefaultSchemaOptions> & import("mongoose").FlatRecord<AgentRole> & {
    _id: Types.ObjectId;
} & {
    __v: number;
}>;
