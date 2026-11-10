import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type PlivoCallDocument = PlivoCall & Document<Types.ObjectId>;

export type PlivoCallDirection = 'outbound' | 'inbound';
export type PlivoCallStatus = 'initiated' | 'in_progress' | 'completed' | 'no_answer' | 'busy' | 'failed' | 'cancelled';
// Where the call's recording is on its way to becoming a Call Copilot session
// (transcript + summary + AI Coach).
export type PlivoImportStatus = 'none' | 'pending' | 'imported' | 'failed';

// One phone call through Plivo — a log of what happened plus the link to the
// Call Copilot session made from its recording. The document's id is what ties
// Plivo's webhooks back to us: it is embedded in the Answer/Recording/Hangup
// URLs Plivo is given, so a callback identifies its call without relying on
// anything the caller can influence.
@Schema({ timestamps: true, collection: 'plivo_calls' })
export class PlivoCall {
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true, index: true })
  userId: string;

  @Prop({ required: true, enum: ['outbound', 'inbound'] })
  direction: PlivoCallDirection;

  @Prop({ required: true })
  plivoNumber: string;

  @Prop({ required: true })
  agentPhone: string;

  @Prop({ required: true })
  customerNumber: string;

  // Outbound only: the deal/customer this call was placed for, so the call
  // session gets that CRM context.
  @Prop()
  dealId?: string;

  @Prop({ default: 'en' })
  languageCode: string;

  // Plivo's ids: the request that placed an outbound call, and the live call.
  @Prop()
  requestUuid?: string;

  @Prop({ index: true, sparse: true })
  callUuid?: string;

  @Prop({
    default: 'initiated',
    enum: ['initiated', 'in_progress', 'completed', 'no_answer', 'busy', 'failed', 'cancelled'],
  })
  status: PlivoCallStatus;

  @Prop()
  failureReason?: string;

  // What went wrong, as one of calling/call-outcome.ts's CallFailure codes, when
  // the webhook that reported it could tell (the reason above is its wording).
  @Prop()
  failureCode?: string;

  // True once the customer leg's own outcome is known (from the <Dial> action),
  // so the agent leg's later "completed" can't overwrite "no answer"/"busy".
  @Prop({ default: false })
  dialOutcomeKnown: boolean;

  // Plivo's HangupCauseName for the call ("Normal Hangup", "Error Reaching Answer URL"…).
  @Prop()
  hangupCause?: string;

  // When the agent picked up (outbound: our Answer webhook ran), and when the far
  // end picked up (the customer, outbound; the agent, inbound) — the moment the
  // two were connected, which the Dialer's "In call" timer counts from.
  @Prop()
  agentAnsweredAt?: Date;

  @Prop()
  answeredAt?: Date;

  @Prop()
  durationSeconds?: number;

  // The Dialer's key for one tap of its call button: the same key again is the
  // same call, never a second one (unique per user, see the index below).
  @Prop()
  clientRequestId?: string;

  // Who was called, as the caller picked them (a customer from Contacts).
  @Prop()
  customerName?: string;

  // Plivo's recording id. Unique, and claimed atomically when the recording
  // webhook arrives, so a redelivered webhook can never import a call twice.
  @Prop({ unique: true, sparse: true })
  recordingId?: string;

  @Prop()
  recordingUrl?: string;

  @Prop()
  recordingDurationSeconds?: number;

  @Prop({ default: 'none', enum: ['none', 'pending', 'imported', 'failed'] })
  importStatus: PlivoImportStatus;

  @Prop()
  importError?: string;

  // The Call Copilot session made from the recording.
  @Prop({ index: true, sparse: true })
  sessionId?: string;

  createdAt: Date;
  updatedAt: Date;
}

export const PlivoCallSchema = SchemaFactory.createForClass(PlivoCall);
PlivoCallSchema.index({ organizationId: 1, createdAt: -1 });
PlivoCallSchema.index({ userId: 1, createdAt: -1 });
PlivoCallSchema.index({ userId: 1, clientRequestId: 1 }, { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } });
