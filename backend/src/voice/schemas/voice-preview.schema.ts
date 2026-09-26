import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type VoicePreviewDocument = VoicePreview & Document;

// A week: long enough that repeated previews cost the provider nothing, short
// enough that a changed provider voice or delivery preset never lingers.
export const VOICE_PREVIEW_TTL_SECONDS = 7 * 24 * 60 * 60;

// One cached sample of a voice speaking the fixed preview sentence. Not tenant
// data — the audio for a given voice + personality is identical for everyone,
// so this collection is global; who may hear it is decided per request. The key
// is a hash that also covers the voice's provider selector and the sample text,
// so editing either in the catalog retires the old entry without a migration.
// Expiry is a TTL index on createdAt (rewritten on every refresh), which is why
// this is a plain collection and not GridFS — clips are ~100-300 KB, and the
// TTL gives refresh for free.
@Schema({ collection: 'voice_previews' })
export class VoicePreview {
  @Prop({ required: true, unique: true })
  key: string;

  @Prop({ required: true })
  contentType: string;

  @Prop({ type: Buffer, required: true })
  audio: Buffer;

  @Prop({ default: Date.now, expires: VOICE_PREVIEW_TTL_SECONDS })
  createdAt: Date;
}

export const VoicePreviewSchema = SchemaFactory.createForClass(VoicePreview);
