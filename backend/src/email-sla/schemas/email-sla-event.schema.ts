import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type EmailSlaEventDocument = EmailSlaEvent & Document<Types.ObjectId>;

export const EMAIL_SLA_EVENT_TYPES = ['created', 'responded', 'breached', 'escalated', 'resolved', 'excluded'] as const;
export type EmailSlaEventType = (typeof EMAIL_SLA_EVENT_TYPES)[number];

// Append-only audit trail, one row per state transition on an EmailSlaRecord
// — same immutable-ledger philosophy as WalletTransaction/
// BillingSubscriptionEvent elsewhere in this codebase. Never updated after
// creation.
@Schema({ timestamps: true, collection: 'email_sla_events' })
export class EmailSlaEvent {
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true, index: true })
  recordId: string;

  @Prop({ required: true, enum: EMAIL_SLA_EVENT_TYPES })
  type: EmailSlaEventType;

  @Prop({ type: Object, default: {} })
  metadata: Record<string, unknown>;

  createdAt: Date;
}

export const EmailSlaEventSchema = SchemaFactory.createForClass(EmailSlaEvent);
EmailSlaEventSchema.index({ organizationId: 1, createdAt: -1 });
