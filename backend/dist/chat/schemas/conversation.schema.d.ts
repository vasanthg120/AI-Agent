import { Document, Types } from 'mongoose';
export type ConversationDocument = Conversation & Document<Types.ObjectId>;
export interface MessageAttachment {
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
}
export declare class ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    toolsUsed: string[];
    attachments?: MessageAttachment[];
    createdAt: Date;
}
export declare class Conversation {
    userId: string;
    organizationId: string;
    title: string;
    agentId?: string;
    messages: ChatMessage[];
    pinned: boolean;
    favorite: boolean;
    archived: boolean;
}
export declare const ConversationSchema: import("mongoose").Schema<Conversation, import("mongoose").Model<Conversation, any, any, any, Document<unknown, any, Conversation, any, {}> & Conversation & {
    _id: Types.ObjectId;
} & {
    __v: number;
}, any>, {}, {}, {}, {}, import("mongoose").DefaultSchemaOptions, Conversation, Document<unknown, {}, import("mongoose").FlatRecord<Conversation>, {}, import("mongoose").DefaultSchemaOptions> & import("mongoose").FlatRecord<Conversation> & {
    _id: Types.ObjectId;
} & {
    __v: number;
}>;
