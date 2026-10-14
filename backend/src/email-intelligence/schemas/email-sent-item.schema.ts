import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type EmailSentItemDocument = EmailSentItem & Document<Types.ObjectId>;

// One message from a connected mailbox's Sent Items — who it went to, when,
// and the same short preview Outlook shows (never the full body). Kept so the
// AI Email Inbox can show sent mail, tell which threads were answered, and
// notice a promised follow-up that never went out. Written by
// EmailHistoryService (history import + every sync); owned by one user's
// mailbox in one organization.
@Schema({ timestamps: true, collection: 'email_sent_items' })
export class EmailSentItem {
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ required: true, index: true })
  userId: string;

  @Prop({ required: true })
  mailboxEmail: string;

  @Prop({ required: true })
  externalMessageId: string;

  @Prop({ index: true })
  conversationId?: string;

  @Prop({ required: true })
  sentAt: Date;

  @Prop({ default: '' })
  subject: string;

  @Prop({ type: [String], default: [] })
  toAddresses: string[];

  @Prop({ type: [String], default: undefined })
  ccAddresses?: string[];

  // The address the mailbox sent as (often an alias, not the sign-in address).
  @Prop()
  fromAddress?: string;

  // RFC threading: this message's own Message-ID and the ones it answers.
  // These tie a reply to the customer's message even when Outlook files the
  // two under different conversations or the subject was changed.
  @Prop()
  internetMessageId?: string;

  @Prop()
  inReplyTo?: string;

  @Prop({ type: [String], default: undefined })
  references?: string[];

  @Prop({ default: '' })
  bodyPreview: string;

  createdAt: Date;
  updatedAt: Date;
}

export const EmailSentItemSchema = SchemaFactory.createForClass(EmailSentItem);
EmailSentItemSchema.index({ userId: 1, externalMessageId: 1 }, { unique: true });
EmailSentItemSchema.index({ userId: 1, sentAt: -1 });
EmailSentItemSchema.index({ userId: 1, conversationId: 1, sentAt: -1 });
