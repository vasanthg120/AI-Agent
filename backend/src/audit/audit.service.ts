import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
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
  // Only ever populated by explicit calls made directly from application
  // code (see audit-log.schema.ts's own comment) — AuditInterceptor's
  // auto-logged entries never set these.
  action?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@InjectModel(AuditLog.name) private auditModel: Model<AuditLogDocument>) {}

  // Fire-and-forget from AuditInterceptor — a failure here (e.g. Mongo
  // briefly unreachable) must never fail, delay, or retry the request it's
  // auditing. Logged locally so a systemic audit-write failure is still
  // visible somewhere, just never at the expense of the actual request.
  async log(entry: AuditEntry): Promise<void> {
    try {
      await this.auditModel.create(entry);
    } catch (err) {
      this.logger.warn(`Failed to write audit log entry: ${(err as Error).message}`);
    }
  }

  list(organizationId: string, limit = 200) {
    return this.auditModel.find({ organizationId }).sort({ createdAt: -1 }).limit(limit).exec();
  }

  /** Platform-wide read for Admin-haive's Audit Logs page — no
   * organizationId filter, unlike list() above (which stays org-scoped for
   * the existing @Roles('admin') self-org viewer). Only reachable via
   * AuditController's separate @Roles('platform_admin') route. */
  async listAll(filters: { userId?: string; route?: string; page?: number; limit?: number }) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 100;
    const query: Record<string, unknown> = {};
    if (filters.userId) query.userId = filters.userId;
    if (filters.route) query.route = { $regex: filters.route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const [items, total] = await Promise.all([
      this.auditModel.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).exec(),
      this.auditModel.countDocuments(query).exec(),
    ]);
    return { items, total, page, limit };
  }
}
