import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type StatusDefinitionDocument = StatusDefinition & Document<Types.ObjectId>;

// Phase 2a of the Hoops-parity plan — the display metadata (label, color,
// order) for an existing, already-recognized status value. Deliberately NOT
// a mechanism for inventing new status values yet: Deal.dealStatus is a
// real Mongoose enum (@Prop({enum:['open','won','lost']})) and several
// dashboards/revenue calculations pattern-match on the literal strings
// 'open'/'won'/'lost' — a genuinely new key would need that logic updated
// first (see the Hoops Parity Plan doc's Section 5 risk notes), which this
// phase does not touch. `key` here always matches a value the rest of the
// app already understands; this collection only changes how it's labeled
// and colored, never what it means.
@Schema({ timestamps: true, collection: 'status_definitions' })
export class StatusDefinition {
  @Prop({ required: true, index: true })
  organizationId: string;

  // Which status column this row describes — one of StatusDefinitionsService's
  // own fixed, known field keys (e.g. 'deal.dealStatus'), never an arbitrary
  // caller-supplied string; see the service for the allow-list.
  @Prop({ required: true })
  field: string;

  // The actual stored value on the Deal/Quote document (e.g. 'won') —
  // never changes once seeded; only label/color/order are editable.
  @Prop({ required: true })
  key: string;

  @Prop({ required: true })
  label: string;

  @Prop()
  color?: string;

  @Prop({ default: 0 })
  order: number;

  @Prop({ default: true })
  active: boolean;
}

export const StatusDefinitionSchema = SchemaFactory.createForClass(StatusDefinition);
// One row per (org, field, key) — matches every other org-scoped
// compound-unique pattern in this codebase (IntegrationCredential,
// DealOwnerMapping, ...).
StatusDefinitionSchema.index({ organizationId: 1, field: 1, key: 1 }, { unique: true });
