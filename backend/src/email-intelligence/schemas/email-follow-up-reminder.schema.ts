import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type EmailFollowUpReminderDocument = EmailFollowUpReminder & Document<Types.ObjectId>;

// Phase 14e — a small, dedicated schema for post-send follow-up reminders.
// Deliberately NOT an insert into DailyReport.tasks: that array is
// wholesale-replaced by DashboardService.recordDailyReport() on every
// scheduled morning/EOD report generation, which would silently wipe an
// ad-hoc reminder the next time a report runs for the same
// (organizationId, storeId, agentId, reportType, date) key.
@Schema({ timestamps: true, collection: 'email_follow_up_reminders' })
export class EmailFollowUpReminder {
  @Prop({ required: true, index: true })
  organizationId: string;

  // Self-scope key — the salesperson who sent the reply this reminder
  // follows up on.
  @Prop({ required: true, index: true })
  userId: string;

  @Prop({ required: true })
  emailIntelligenceItemId: string;

  // Additive — the (organizationId, emailIntelligenceItemId, reminderType)
  // unique index below is the dedup fix for the audited bug (createFollowUpReminder
  // previously had no existence check, so replying more than once in the
  // reminder window created duplicate overlapping reminders). Defaults to
  // 'post_reply' so every reminder created by the existing 3-day-after-send
  // trigger keeps working unchanged; a future silence-detection trigger can
  // use a different type without colliding with it.
  @Prop({ default: 'post_reply', index: true })
  reminderType: string;

  @Prop()
  businessName?: string;

  @Prop({ required: true })
  title: string;

  @Prop({ required: true })
  dueDate: Date;

  @Prop({ enum: ['pending', 'done', 'dismissed'], default: 'pending', index: true })
  status: 'pending' | 'done' | 'dismissed';

  // ---- AI Follow-up action layer (additive) ----
  @Prop()
  draftReply?: string;

  @Prop({ enum: ['none', 'generating', 'pending_review', 'approved', 'sent', 'failed'], default: 'none' })
  draftStatus: 'none' | 'generating' | 'pending_review' | 'approved' | 'sent' | 'failed';

  @Prop()
  draftGeneratedAt?: Date;

  @Prop()
  sentAt?: Date;

  @Prop()
  sendError?: string;

  // ---- SLA-breach trigger (additive) — reminderType: 'sla_breach', see
  // email-intelligence.service.ts's createSlaBreachFollowUp. Everything
  // above this line is shared unchanged with the existing 'post_reply'
  // reminders (same status/draftStatus state machine, same generate/
  // approve/send actions) — these fields are only ever populated for the
  // new trigger type. ----

  // Traceability back to the EmailSlaRecord that triggered this reminder —
  // not used for dedup (the existing {organizationId, emailIntelligenceItemId,
  // reminderType} unique index above already guarantees that), just audit.
  @Prop()
  slaRecordId?: string;

  @Prop()
  dismissedAt?: Date;

  @Prop()
  dismissedReason?: string;

  // What the AI draft actually drew on for THIS specific draft — real,
  // per-generation facts (not a static capability flag), so the review UI's
  // "AI used relevant context" indicator never claims something that wasn't
  // actually used.
  @Prop({ type: Object })
  contextUsed?: { thread: boolean; crm: boolean; businessKnowledge: boolean };

  createdAt: Date;
  updatedAt: Date;
}

export const EmailFollowUpReminderSchema = SchemaFactory.createForClass(EmailFollowUpReminder);
EmailFollowUpReminderSchema.index({ userId: 1, status: 1, dueDate: 1 });
// Duplicate-reminder prevention — the fix for the audited bug (see
// reminderType's own comment above).
EmailFollowUpReminderSchema.index({ organizationId: 1, emailIntelligenceItemId: 1, reminderType: 1 }, { unique: true });
