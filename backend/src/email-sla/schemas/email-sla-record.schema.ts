import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type EmailSlaRecordDocument = EmailSlaRecord & Document<Types.ObjectId>;

export const EMAIL_SLA_STATUSES = ['PENDING', 'IN_PROGRESS', 'RESPONDED', 'BREACHED', 'ESCALATED', 'EXCLUDED'] as const;
export type EmailSlaStatus = (typeof EMAIL_SLA_STATUSES)[number];

// One row per EmailIntelligenceItem that's SLA-eligible (see
// email-sla.service.ts's createOrUpdateRecordForItem — eligibility reuses
// the existing aiStatus==='draft_ready' classification result, never a new
// exclusion heuristic). Deliberately references the email by id only
// (`emailId`) rather than duplicating its content — this collection is pure
// SLA-tracking metadata.
@Schema({ timestamps: true, collection: 'email_sla_records' })
export class EmailSlaRecord {
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true })
  emailId: string;

  // Present only if Email Inbox ever gains a real thread concept (see the
  // audit — it doesn't today); left optional/unused rather than invented.
  @Prop()
  conversationId?: string;

  // The mailbox owner today (EmailIntelligenceItem.userId) — real per-user
  // assignment doesn't exist in Email Inbox yet either (per the audit), so
  // this is the closest real "who owns responding to this" value.
  @Prop({ required: true, index: true })
  assignedUserId: string;

  @Prop({ required: true })
  receivedAt: Date;

  @Prop({ required: true })
  slaStartedAt: Date;

  @Prop({ required: true, index: true })
  slaDueAt: Date;

  @Prop()
  firstResponseAt?: Date;

  @Prop()
  responseTimeSeconds?: number;

  @Prop({ required: true, enum: EMAIL_SLA_STATUSES, default: 'PENDING', index: true })
  status: EmailSlaStatus;

  @Prop({ required: true })
  priority: string;

  @Prop({ default: false })
  isBreached: boolean;

  @Prop()
  breachedAt?: Date;

  @Prop()
  escalatedAt?: Date;

  // Only ever advances forward (0 -> 1 -> 2 -> ...) — the escalation
  // scheduler's sole guard against re-notifying the same level twice (see
  // email-sla-escalation.service.ts).
  @Prop({ default: 0 })
  escalationLevel: number;

  @Prop({ default: false })
  businessHoursApplied: boolean;

  @Prop()
  excludedReason?: string;

  createdAt: Date;
  updatedAt: Date;
}

export const EmailSlaRecordSchema = SchemaFactory.createForClass(EmailSlaRecord);
// Duplicate-record prevention (spec's own required index) — also the
// upsert key createOrUpdateRecordForItem relies on for idempotency.
EmailSlaRecordSchema.index({ organizationId: 1, emailId: 1 }, { unique: true });
EmailSlaRecordSchema.index({ organizationId: 1, status: 1 });
EmailSlaRecordSchema.index({ organizationId: 1, slaDueAt: 1 });
EmailSlaRecordSchema.index({ organizationId: 1, isBreached: 1 });
EmailSlaRecordSchema.index({ organizationId: 1, assignedUserId: 1 });
