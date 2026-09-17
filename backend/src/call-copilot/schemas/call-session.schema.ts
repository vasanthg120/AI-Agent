import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CallSessionDocument = CallSession & Document<Types.ObjectId>;

@Schema({ _id: false })
export class CallTranscriptSegment {
  @Prop({ required: true })
  sequence: number;

  // NOT required, unlike every other `text` field in this schema — an empty
  // string is a legitimate value here (a silent segment, or one Sarvam
  // failed to transcribe; see call-copilot.service.ts's appendAudioSegment),
  // not an error state. Mongoose's required validator rejects '' the same
  // as missing/null for a String path (the exact bug already hit once for
  // ChatMessage.content — see conversation.schema.ts), which turned every
  // quiet moment of a call into a save failure that cascaded: the failed
  // save left the invalid segment sitting in the in-memory document, so the
  // NEXT segment's save failed too, compounding until call:end's own save
  // failed the same way, leaving the session stuck 'active' with its credit
  // reservation never settled. Unlike ChatMessage.content, this can't be
  // fixed by substituting a placeholder string instead — that would pollute
  // both the analysis transcript window (`.filter(Boolean)` no longer drops
  // it) and the live transcript shown to the user.
  @Prop({ default: '' })
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

  // Diarization label ("0"/"1", per Sarvam's batch STT speaker_id) — only
  // ever set for an uploaded recording processed with diarization; always
  // undefined for a live call (single-mic capture has no speaker channel to
  // separate) and for an upload where diarization wasn't available.
  @Prop()
  speaker?: string;
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

  // Optional, NOT required — added after this schema shipped, so existing
  // ended sessions' stored follow-up actions have no owner field at all.
  // Marking it required would fail Mongoose validation the next time one of
  // those old documents gets re-saved (e.g. a future unrelated field update
  // on the same session), the exact class of bug already hit once for
  // CallTranscriptSegment.text above. The frontend defaults a missing value
  // to 'salesperson' for display.
  @Prop({ enum: ['salesperson', 'customer'] })
  owner?: string;
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

  // 'processing' is new — an uploaded recording's session sits here while
  // the background transcribe/analyze/summarize pipeline runs (see
  // call-copilot-upload.service.ts), before landing on 'ended'/'error' the
  // same as a live call. A live call never enters 'processing' — it goes
  // straight from 'active' to 'ended'/'error'.
  @Prop({ required: true, enum: ['active', 'processing', 'ended', 'error'], default: 'active', index: true })
  status: 'active' | 'processing' | 'ended' | 'error';

  // Distinguishes a live-recorded call from an uploaded pre-recorded one —
  // drives the Library page's Live/Uploaded badge and which playback
  // granularity applies (per-segment clips vs. one call-level file).
  @Prop({ required: true, enum: ['live', 'upload'], default: 'live' })
  source: 'live' | 'upload';

  // GridFS id (bucket: call_recordings) of the untouched originally-uploaded
  // file — only set for source:'upload'. Distinct from transcript[].audioFileId:
  // an uploaded call's segments all point back at THIS one file (there's no
  // per-turn clip, since the whole file went to Sarvam's batch API in one
  // shot), unlike a live call where every segment has its own GridFS file.
  @Prop()
  originalRecordingFileId?: string;

  @Prop()
  originalFilename?: string;

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

  // Legacy single-paragraph summary — kept for backward compatibility with
  // every session ended before the structured summary shipped (see headline/
  // outcome/summaryPoints below). New sessions leave this empty and use the
  // structured fields instead; CallSummaryModal falls back to rendering this
  // when summaryPoints is empty, so old sessions keep displaying correctly.
  @Prop()
  summary?: string;

  @Prop()
  headline?: string;

  @Prop({ enum: ['moving_forward', 'needs_follow_up', 'objection_raised', 'no_decision', 'lost', 'not_applicable'] })
  outcome?: string;

  @Prop({ type: [String], default: [] })
  summaryPoints: string[];

  @Prop({ type: [String], default: [] })
  customerNeeds: string[];

  @Prop({ type: [String], default: [] })
  concernsRaised: string[];

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
