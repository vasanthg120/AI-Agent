import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ConversationDocument = Conversation & Document<Types.ObjectId>;

@Schema({ _id: false })
export class ChatMessage {
  @Prop({ required: true, enum: ['user', 'assistant'] })
  role: 'user' | 'assistant';

  @Prop({ required: true })
  content: string;

  @Prop({ type: [String], default: [] })
  toolsUsed: string[];

  @Prop({ default: () => new Date() })
  createdAt: Date;
}

@Schema({ timestamps: true })
export class Conversation {
  @Prop({ required: true, index: true })
  userId: string;

  // Not needed for ownership checks (userId alone already isolates — a
  // user's id is unique across the whole deployment, not just their org) but
  // required for any future org-wide query (AI Timeline, Command Center
  // execution history) that needs to look across conversations without
  // enumerating every user first.
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop({ default: 'New conversation' })
  title: string;

  // Which persona (see backend/src/chat/agents.ts) this conversation talks
  // to — set once (first @mention, or a scheduled report's author) and
  // sticky for the conversation's lifetime. Undefined = generic assistant,
  // today's default behavior.
  @Prop()
  agentId?: string;

  @Prop({ type: [ChatMessage], default: [] })
  messages: ChatMessage[];

  // Previously session-local-only UI state on the frontend (chatService.ts's
  // setConversationFlag/renameConversation/deleteConversation were all
  // literal no-ops, "not supported by the backend yet") — every one of these
  // was silently lost on reload, which is exactly why pinning/favoriting/
  // archiving/renaming a conversation "didn't work." Real persisted fields now.
  @Prop({ default: false, index: true })
  pinned: boolean;

  @Prop({ default: false })
  favorite: boolean;

  @Prop({ default: false, index: true })
  archived: boolean;
}

export const ConversationSchema = SchemaFactory.createForClass(Conversation);
