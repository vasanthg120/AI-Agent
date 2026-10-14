import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ChatAttachmentDocument = ChatAttachment & Document<Types.ObjectId>;

// A document someone attached in the AI chat. Only its extracted text is kept
// (encrypted) — never the original file — together with who uploaded it and
// which conversation it belongs to. python-agent reads it (scoped to that
// user, organization and conversation) to answer questions about it; see
// python-agent/app/memory/chat_attachment_store.py.
@Schema({ timestamps: true, collection: 'chat_attachments' })
export class ChatAttachment {
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true, index: true })
  userId: string;

  // Set when the message carrying it is sent; until then it's a pending upload.
  @Prop({ index: true })
  conversationId?: string;

  @Prop({ required: true })
  filename: string;

  @Prop({ required: true })
  extension: string;

  @Prop({ required: true })
  mimeType: string;

  @Prop({ required: true })
  sizeBytes: number;

  // Of the original file — recognises a re-upload of the same document.
  @Prop({ required: true })
  sha256: string;

  @Prop({ required: true, enum: ['ready'], default: 'ready' })
  status: 'ready';

  // AES-256-GCM (EncryptionService); never returned by any endpoint.
  @Prop({ required: true, select: false })
  textEncrypted: string;

  @Prop({ required: true })
  extractedChars: number;

  // The document was longer than what is kept (see python-agent's MAX_EXTRACTED_CHARS).
  @Prop({ default: false })
  truncated: boolean;

  // Mongo removes the attachment at this time: a day for an upload that was
  // never sent, the retention period for one that was.
  @Prop({ required: true })
  expiresAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const ChatAttachmentSchema = SchemaFactory.createForClass(ChatAttachment);
ChatAttachmentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
ChatAttachmentSchema.index({ userId: 1, sha256: 1 });
ChatAttachmentSchema.index({ conversationId: 1, userId: 1, createdAt: -1 });
