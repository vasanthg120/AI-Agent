import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CallSessionDocument = CallSession & Document<Types.ObjectId>;

@Schema({ _id: false })
export class CallTranscriptSegment {
  @Prop({ required: true })
  sequence: number;

  @Prop({ required: true })
  text: string;

  // GridFS file id (bucket: call_recordings) for this segment's raw audio —
  // each segment is its own independently-valid WebM/Opus file (see
  // call-copilot.gateway.ts's comment on why segments are stop/restart
  // MediaRecorder instances, not a single continuous timeslice stream), so
  // no concatenation step is needed to play any segment back on its own.
  @Prop({ required: true })
  audioFileId: string;

  @Prop({ default: () => new Date() })
  recordedAt: Date;
}

@Schema({ _id: false })
export class CallEvent {
  @Prop({
    required: true,
    enum: [
      'intent', 'requirement', 'objection', 'pain_point', 'competitor',
      'budget', 'timeline', 'buying_signal', 'commitment',
    ],
  })
  type: string;

  @Prop({ required: true })
  text: string;

  @Prop({ default: () => new Date() })
  detectedAt: Date;
}

@Schema({ _id: false })
export class CallRecommendation {
  @Prop({ required: true, enum: ['say', 'ask', 'handle_objection', 'next_action'] })
  type: string;

  @Prop({ required: true })
  text: string;

  @Prop({ default: () => new Date() })
  createdAt: Date;
}

@Schema({ _id: false })
export class CallFollowUpAction {
  @Prop({ required: true })
  text: string;

  @Prop({ required: true, enum: ['high', 'medium', 'low'] })
  priority: string;
}

// One row per Record session. Mirrors credit-reservation.schema.ts's
// pending/settled/released-style lifecycle convention (see that schema's own
// comment) — here as active/ended/error, since a call session's "unit of
// work" is the whole call, not a single request.
@Schema({ timestamps: true, collection: 'call_sessions' })
export class CallSession {
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true, index: true })
  userId: string;

  // Optional CRM linkage (confirmed: linkage is recommended, not required —
  // an unlinked call still works with thinner context). Deal is the primary
  // link since Deal already carries contactId/accountId; contactId is kept
  // as a fallback for a call about a contact with no deal yet.
  @Prop()
  dealId?: string;

  @Prop()
  contactId?: string;

  @Prop({ required: true, enum: ['active', 'ended', 'error'], default: 'active', index: true })
  status: 'active' | 'ended' | 'error';

  // Fetched once at call start (business_search_tool.run() — CRM + shared
  // documents + business knowledge + Mem0), never re-fetched mid-call.
  @Prop()
  contextBlob?: string;

  @Prop({ type: [CallTranscriptSegment], default: [] })
  transcript: CallTranscriptSegment[];

  // The `sequence` of the last transcript segment already included in a
  // successful (non-skipped) analysis call — segments after this are "new"
  // for the next analysis cycle's word-count gate (see
  // call-copilot.service.ts's maybeAnalyze). Stays put across a skipped
  // cycle so new text keeps accumulating toward the threshold instead of
  // being silently dropped.
  @Prop({ default: 0 })
  lastAnalyzedSequence: number;

  @Prop({ type: [CallEvent], default: [] })
  events: CallEvent[];

  @Prop({ type: [CallRecommendation], default: [] })
  recommendations: CallRecommendation[];

  @Prop()
  sentiment?: string;

  @Prop()
  summary?: string;

  @Prop({ type: [String], default: [] })
  keyTakeaways: string[];

  @Prop({ type: [CallFollowUpAction], default: [] })
  followUpActions: CallFollowUpAction[];

  // Reservation.requestId for ReservationService.reserve/settle/release —
  // one reservation covers the whole call session (no lightweight per-
  // analysis-tick metering primitive exists; see the plan's own note on
  // this tradeoff), settled at call end, released if the session errors
  // out before ending normally.
  @Prop({ required: true, unique: true })
  creditRequestId: string;

  @Prop()
  endedAt?: Date;

  @Prop()
  errorMessage?: string;
}

export const CallSessionSchema = SchemaFactory.createForClass(CallSession);
CallSessionSchema.index({ organizationId: 1, userId: 1, createdAt: -1 });
