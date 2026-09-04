import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type EmailSlaPolicyDocument = EmailSlaPolicy & Document<Types.ObjectId>;

// EmailIntelligenceItem.priority is a free-form string set by the existing
// classification pipeline (low/medium/high/urgent in practice, never a
// strict enum on that schema — see email-intelligence-item.schema.ts) — this
// module matches on the same string values rather than redefining priority.
export const DEFAULT_PRIORITY_SLA_MINUTES: Record<string, number> = {
  urgent: 30,
  high: 120,
  medium: 480,
  low: 1440,
};

// One row per (organization, priority) — additive, references the existing
// classification's priority string by value, same no-populate/no-enum-
// coupling convention as BillingPlanFeatureGrant.featureKey elsewhere in
// this codebase. Absence of a row for a given org+priority falls back to
// DEFAULT_PRIORITY_SLA_MINUTES (see email-sla-policy.service.ts) — an org
// never needs to configure anything before SLA tracking works.
@Schema({ timestamps: true, collection: 'email_sla_policies' })
export class EmailSlaPolicy {
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true })
  priority: string;

  @Prop({ required: true })
  firstResponseTimeMinutes: number;

  @Prop({ default: true })
  businessHoursEnabled: boolean;

  @Prop({ default: true, index: true })
  enabled: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export const EmailSlaPolicySchema = SchemaFactory.createForClass(EmailSlaPolicy);
EmailSlaPolicySchema.index({ organizationId: 1, priority: 1 }, { unique: true });
