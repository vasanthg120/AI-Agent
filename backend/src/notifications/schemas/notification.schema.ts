import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type NotificationDocument = Notification & Document<Types.ObjectId>;

// Matches the frontend's NotificationKind exactly (frontend/src/services/mock/fixtures/notifications.ts) —
// the frontend's mock fixtures were the only definition of this shape before this schema existed.
// 'sla_breach' is additive (Email SLA escalation, see email-sla-escalation.service.ts) — every
// existing kind/consumer is unaffected.
export const NOTIFICATION_KINDS = ['system', 'integration', 'warning', 'error', 'sla_breach'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

// What kind of record entityId below points at — the frontend's click
// dispatcher (frontend/src/utils/notificationTarget.ts) maps each of these
// to a route + which query param to open it with. Deliberately a flat list
// rather than per-module sub-schemas: every consumer only ever needs "what
// type is this, what's its id", never anything richer, and a new entity
// type is a one-line addition here plus one dispatcher-map entry, not a
// schema migration.
export const NOTIFICATION_ENTITY_TYPES = [
  'email',
  'financeDocument',
  'deal',
  'task',
  'outlookAccount',
  'dailyReport',
] as const;
export type NotificationEntityType = (typeof NOTIFICATION_ENTITY_TYPES)[number];

@Schema({ timestamps: true, collection: 'notifications' })
export class Notification {
  @Prop({ required: true })
  userId: string;

  // Optional: userId alone already isolates this by owner (a user's id is
  // unique across the whole deployment), so this doesn't gate access — it's
  // here so a future org-wide view (AI Timeline, admin notification audit)
  // doesn't have to resolve userId -> organizationId for every row. Not
  // every creation path has an org in hand (e.g. gamification's
  // recordTaskCompletion only has a userId), so this stays optional rather
  // than forcing a lookup on every write.
  @Prop()
  organizationId?: string;

  @Prop({ required: true, enum: NOTIFICATION_KINDS })
  kind: NotificationKind;

  @Prop({ required: true })
  title: string;

  @Prop({ required: true })
  description: string;

  @Prop({ default: false })
  read: boolean;

  // Set when python-agent's Planner/workflows created this proactively, with
  // no live user turn behind it (see python-agent/app/notifications/client.py)
  // — e.g. "workflow:crm_follow_up_check". Absent for anything created via a
  // live authenticated request.
  @Prop()
  source?: string;

  // Which record this notification is *about* — lets the frontend jump
  // straight to it instead of the user having to go find it themselves
  // (see frontend/src/utils/notificationTarget.ts). Both optional and
  // always set together: absent on any notification that isn't about one
  // specific addressable record (e.g. "Achievement unlocked"), or on any
  // older row written before this existed — the click handler already
  // falls back to just marking read + showing the detail panel when
  // there's no target to navigate to, so this is purely additive.
  @Prop({ enum: NOTIFICATION_ENTITY_TYPES })
  entityType?: NotificationEntityType;

  @Prop()
  entityId?: string;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);
