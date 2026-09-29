import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type TwilioLineDocument = TwilioLine & Document<Types.ObjectId>;

// One Twilio number and the person who takes its calls — Twilio's counterpart
// of PlivoLine, used for international calling. A customer dials `twilioNumber`
// and Twilio forwards to `agentPhone`, recorded; or the agent clicks "Call" in
// HaiVE, Twilio rings `agentPhone` first and then dials the customer from
// `twilioNumber`.
@Schema({ timestamps: true, collection: 'twilio_lines' })
export class TwilioLine {
  @Prop({ required: true, index: true })
  organizationId: string;

  // Digits only, country code included (14155550123). Globally unique: an
  // inbound webhook finds its organization by this number alone.
  @Prop({ required: true, unique: true })
  twilioNumber: string;

  // Twilio's id for the number (PN…) — what HaiVE uses to point the number's
  // voice webhook at itself.
  @Prop()
  numberSid?: string;

  @Prop({ required: true, index: true })
  userId: string;

  // The agent's real phone (digits only) — rung by Twilio for every call.
  @Prop({ required: true })
  agentPhone: string;

  @Prop({ default: 'en' })
  languageCode: string;

  @Prop()
  label?: string;

  // Tell the other party the call is recorded before connecting — required for
  // many international destinations (e.g. two-party-consent jurisdictions).
  @Prop({ default: true })
  announceRecording: boolean;

  @Prop({ default: true })
  active: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export const TwilioLineSchema = SchemaFactory.createForClass(TwilioLine);
