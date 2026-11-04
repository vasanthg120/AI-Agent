import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type TwilioCallDocument = TwilioCall & Document<Types.ObjectId>;

export type TwilioCallDirection = 'outbound' | 'inbound';
// Same vocabulary as PlivoCall, so the call log and Call Copilot treat both
// providers' calls identically.
export type TwilioCallStatus = 'initiated' | 'in_progress' | 'completed' | 'no_answer' | 'busy' | 'failed' | 'cancelled';
export type TwilioImportStatus = 'none' | 'pending' | 'imported' | 'failed';

// One phone call through Twilio. Its id is embedded in every webhook URL Twilio
// is given, so a callback identifies its call from data we created.
@Schema({ timestamps: true, collection: 'twilio_calls' })
export class TwilioCall {
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true, index: true })
  userId: string;

  @Prop({ required: true, enum: ['outbound', 'inbound'] })
  direction: TwilioCallDirection;

  @Prop({ required: true })
  twilioNumber: string;

  @Prop({ required: true })
  agentPhone: string;

  @Prop({ required: true })
  customerNumber: string;

  @Prop()
  dealId?: string;

  @Prop({ default: 'en' })
  languageCode: string;

  // Twilio's id for the call (CA…): the agent leg for a click-to-call, the
  // caller's leg for an inbound call.
  @Prop({ index: true, sparse: true })
  callSid?: string;

  @Prop({
    default: 'initiated',
    enum: ['initiated', 'in_progress', 'completed', 'no_answer', 'busy', 'failed', 'cancelled'],
  })
  status: TwilioCallStatus;

  // True once the customer leg's own outcome is known (from the <Dial> action),
  // so the agent leg's later "completed" can't overwrite "no answer"/"busy".
  @Prop({ default: false })
  dialOutcomeKnown: boolean;

  @Prop()
  failureReason?: string;

  // What went wrong, as one of calling/call-outcome.ts's CallFailure codes, when
  // the webhook that reported it could tell (the reason above is its wording).
  @Prop()
  failureCode?: string;

  // When the agent picked up (outbound: our voice webhook ran), and when the far
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

  // Twilio's recording id (RE…). Unique, and claimed atomically when the
  // recording webhook arrives, so a redelivered webhook never imports twice.
  @Prop({ unique: true, sparse: true })
  recordingSid?: string;

  @Prop()
  recordingUrl?: string;

  @Prop()
  recordingDurationSeconds?: number;

  @Prop({ default: 'none', enum: ['none', 'pending', 'imported', 'failed'] })
  importStatus: TwilioImportStatus;

  @Prop()
  importError?: string;

  @Prop({ index: true, sparse: true })
  sessionId?: string;

  createdAt: Date;
  updatedAt: Date;
}

export const TwilioCallSchema = SchemaFactory.createForClass(TwilioCall);
TwilioCallSchema.index({ organizationId: 1, createdAt: -1 });
TwilioCallSchema.index({ userId: 1, createdAt: -1 });
TwilioCallSchema.index({ userId: 1, clientRequestId: 1 }, { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } });
