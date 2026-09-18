import { Document, Types } from 'mongoose';
export type DailyReportDocument = DailyReport & Document<Types.ObjectId>;
export declare class DailyReportTask {
    _id: Types.ObjectId;
    title: string;
    priority: 'urgent' | 'high' | 'medium' | 'low';
    category?: string;
    isOverdue: boolean;
    status: 'todo' | 'in_progress' | 'done';
    relatedDealId?: string;
    relatedQuoteId?: string;
    relatedEmailId?: string;
    assignedUserId?: string;
}
export declare class DailyReport {
    organizationId: string;
    storeId?: string;
    agentId: string;
    reportType: 'morning' | 'eod';
    date: string;
    tasks: DailyReportTask[];
    summary: string;
    sourceConversationId: string;
    sourceUserId: string;
    wasMissed: boolean;
    emailStatus: 'pending' | 'sent' | 'failed';
    emailSentAt?: Date;
    emailError?: string;
    createdAt: Date;
    updatedAt: Date;
}
export declare const DailyReportSchema: import("mongoose").Schema<DailyReport, import("mongoose").Model<DailyReport, any, any, any, Document<unknown, any, DailyReport, any, {}> & DailyReport & {
    _id: Types.ObjectId;
} & {
    __v: number;
}, any>, {}, {}, {}, {}, import("mongoose").DefaultSchemaOptions, DailyReport, Document<unknown, {}, import("mongoose").FlatRecord<DailyReport>, {}, import("mongoose").DefaultSchemaOptions> & import("mongoose").FlatRecord<DailyReport> & {
    _id: Types.ObjectId;
} & {
    __v: number;
}>;
