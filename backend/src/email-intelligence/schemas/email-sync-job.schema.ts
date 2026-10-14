import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type EmailSyncJobDocument = EmailSyncJob & Document<Types.ObjectId>;

// A history collection for the sync button's own audit trail — not a
// queryable business object. One doc per real (non-preview) POST /email-intelligence/
// sync execution. Written best-effort at the end of
// EmailIntelligenceSyncService.syncMyMailbox — a failure to write this doc
// must never fail the sync response itself (see that method's own comment).
@Schema({ timestamps: true, collection: 'email_sync_jobs' })
export class EmailSyncJob {
  @Prop({ required: true, index: true })
  organizationId: string;

  // Self-scope key — matches this module's established self-scoped-only
  // stance (see EmailIntelligenceController's class comment).
  @Prop({ required: true, index: true })
  userId: string;

  // Phase 21 follow-up — 'completed_with_errors' distinguishes "the sync
  // ran end-to-end but some/all items failed" (e.g. a real Anthropic outage)
  // from a genuinely clean run, so the history list never shows a run with
  // 10/10 failures as plain "completed". 'failed' stays reserved for the
  // sync operation itself throwing before finishing (see syncMyMailbox's own
  // outer catch) — a materially different, rarer case. No QUEUED/RUNNING/
  // CANCELLED states: this stays a fully synchronous, click-and-wait
  // operation, not a queue, so those states wouldn't correspond to anything
  // real yet (see Phase 21 follow-up plan notes for why that was scoped out).
  // 'running' is the mailbox's sync lock: at most one sync per mailbox at a time
  // (see the unique index below), across every backend process.
  @Prop({ required: true, enum: ['running', 'completed', 'completed_with_errors', 'failed'] })
  status: 'running' | 'completed' | 'completed_with_errors' | 'failed';

  @Prop({ required: true, default: 0 })
  scannedCount: number;

  @Prop({ required: true, default: 0 })
  newItemsCount: number;

  @Prop({ required: true, default: 0 })
  succeededCount: number;

  @Prop({ required: true, default: 0 })
  failedCount: number;

  // 'scheduled' added alongside the half-hourly background sync
  // (EmailIntelligenceSyncService.runScheduledSync) — both call the exact
  // same syncMyMailbox, but the sync history / "last synced" UI needs to
  // say which happened, since an auto-run finding nothing new means
  // something different to a user than their own click doing the same.
  @Prop({ required: true, enum: ['user', 'scheduled'], default: 'user' })
  triggeredBy: 'user' | 'scheduled';

  @Prop({ required: true })
  startedAt: Date;

  // Absent while the sync is still running.
  @Prop()
  completedAt?: Date;

  // New mail stored without an AI reading (no credits / AI unavailable) — it is
  // tracked and retried, not lost.
  @Prop({ default: 0 })
  deferredCount: number;

  // Emails this run found had been answered in Outlook.
  @Prop({ default: 0 })
  answeredCount: number;

  // More mail was in the window than one run reads; the next run continues.
  @Prop({ default: false })
  truncated: boolean;

  // Why the run failed, in one line (never message content).
  @Prop()
  error?: string;

  // The start of the mailbox window this run read.
  @Prop()
  windowStart?: Date;

  // Set on a run that left messages unstored (failedCount > 0) once a later
  // run has read its window again cleanly. Until then every sync re-reads it.
  @Prop()
  failuresRecovered?: boolean;
}

export const EmailSyncJobSchema = SchemaFactory.createForClass(EmailSyncJob);
EmailSyncJobSchema.index({ userId: 1, createdAt: -1 });
// Named explicitly: the plain `userId` index above already owns the default name.
EmailSyncJobSchema.index({ userId: 1 }, { name: 'one_running_sync_per_user', unique: true, partialFilterExpression: { status: 'running' } });
