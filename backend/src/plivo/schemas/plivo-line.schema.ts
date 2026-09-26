import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type PlivoLineDocument = PlivoLine & Document<Types.ObjectId>;

// One rented Plivo number and the person who takes its calls. It is the bridge
// between the two worlds: a customer dials `plivoNumber`, Plivo forwards to
// `agentPhone` (the agent's own mobile — e.g. their Airtel SIM) and records the
// conversation; or the agent clicks "Call" in HaiVE, Plivo rings `agentPhone`
// first and then dials the customer from `plivoNumber`. Either way the call
// passes through Plivo, which is the only reason it can be recorded.
@Schema({ timestamps: true, collection: 'plivo_lines' })
export class PlivoLine {
  @Prop({ required: true, index: true })
  organizationId: string;

  // Digits only, country code included (919876543210). Globally unique: an
  // inbound webhook finds its organization by this number alone.
  @Prop({ required: true, unique: true })
  plivoNumber: string;

  // The HaiVE user whose calls these are — the call session and its AI coaching
  // report land in their Call Library.
  @Prop({ required: true, index: true })
  userId: string;

  // The agent's real phone (digits only) — rung by Plivo for every call.
  @Prop({ required: true })
  agentPhone: string;

  // The spoken language of these calls, for transcription (a Call Copilot
  // language code such as 'en', 'hi', 'ta').
  @Prop({ default: 'en' })
  languageCode: string;

  @Prop()
  label?: string;

  @Prop({ default: true })
  active: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export const PlivoLineSchema = SchemaFactory.createForClass(PlivoLine);
