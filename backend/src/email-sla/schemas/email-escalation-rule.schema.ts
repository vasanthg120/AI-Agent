import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type EmailEscalationRuleDocument = EmailEscalationRule & Document<Types.ObjectId>;

// One row per (organization, priority, escalationLevel) — checked by the
// same single breach-scan cron tick that detects breaches
// (email-sla-escalation.service.ts), never a second independent scheduler.
// Level numbering starts at 1; a record's own `escalationLevel` field
// (email-sla-record.schema.ts) only ever advances forward through these,
// so a level can never fire twice for the same record.
@Schema({ timestamps: true, collection: 'email_escalation_rules' })
export class EmailEscalationRule {
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true })
  priority: string;

  @Prop({ required: true })
  escalationLevel: number;

  // Minutes after breachedAt (level 1's delay may be 0 — "notify the
  // assigned user immediately on breach").
  @Prop({ required: true })
  delayMinutes: number;

  @Prop({ default: true })
  notifyAssignedUser: boolean;

  @Prop({ default: false })
  notifyManager: boolean;

  @Prop({ default: false })
  notifyAdmin: boolean;

  @Prop({ default: true, index: true })
  enabled: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export const EmailEscalationRuleSchema = SchemaFactory.createForClass(EmailEscalationRule);
EmailEscalationRuleSchema.index({ organizationId: 1, priority: 1, escalationLevel: 1 }, { unique: true });
