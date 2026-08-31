import { Model } from 'mongoose';
import { AuditLog, AuditLogDocument } from './schemas/audit-log.schema';
export interface AuditEntry {
    userId: string;
    organizationId?: string;
    method: string;
    route: string;
    statusCode: number;
    durationMs: number;
    ip?: string;
    action?: string;
    metadata?: Record<string, unknown>;
}
export declare class AuditService {
    private auditModel;
    private readonly logger;
    constructor(auditModel: Model<AuditLogDocument>);
    log(entry: AuditEntry): Promise<void>;
    list(organizationId: string, limit?: number): Promise<(import("mongoose").Document<unknown, {}, AuditLogDocument, {}, {}> & AuditLog & import("mongoose").Document<import("mongoose").Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
        _id: import("mongoose").Types.ObjectId;
    }> & {
        __v: number;
    })[]>;
    listAll(filters: {
        userId?: string;
        route?: string;
        page?: number;
        limit?: number;
    }): Promise<{
        items: (import("mongoose").Document<unknown, {}, AuditLogDocument, {}, {}> & AuditLog & import("mongoose").Document<import("mongoose").Types.ObjectId, any, any, Record<string, any>, {}> & Required<{
            _id: import("mongoose").Types.ObjectId;
        }> & {
            __v: number;
        })[];
        total: number;
        page: number;
        limit: number;
    }>;
}
