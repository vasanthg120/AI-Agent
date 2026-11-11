import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CrmActivityDocument = CrmActivity & Document<Types.ObjectId>;

export type CrmActivityEntity = 'deal' | 'quote';
// deal: created, won, lost, reopened · quote: created, sent, accepted, rejected
export type CrmActivityKind = 'created' | 'won' | 'lost' | 'reopened' | 'sent' | 'accepted' | 'rejected';
// How the time is known:
//  - crm: the CRM's own date for it;
//  - detected: when HaiVE's sync first saw the change (within a sync interval of it);
//  - closing_date: a deal's closing date (date only — the same basis the Dashboard's revenue uses);
//  - assumed: a quotation synced before this log existed counts as sent when it was created;
//  - haive: done in HaiVE itself, by the person signed in.
export type CrmActivityTimeBasis = 'crm' | 'detected' | 'closing_date' | 'assumed' | 'haive';

// The CRM activity log: one row per real change to a deal or a quotation —
// what happened, from which status to which, its value, who did it, when.
// Written by the CRM sync (python-agent crm_mongo_sync.py) when it sees a
// record appear or change, by HaiVE's own deal/quote writes, and backfilled
// once from the dates the CRMs already give (CrmActivityService).
//
// Who: a HaiVE login when it was done in HaiVE (actorUserId); otherwise the
// CRM salesperson it was done under (crmOwnerRef/Label), credited to a person
// only through Settings → Deal Assignment, at read time — so linking a
// salesperson later credits their history too.
//
// dedupeKey is unique: a sync running again, or twice at once, never adds a
// second row for the same change.
@Schema({ collection: 'crm_activities', timestamps: { createdAt: true, updatedAt: false } })
export class CrmActivity {
  @Prop({ required: true, index: true })
  organizationId: string;

  @Prop()
  dataSourceId?: string;

  // The CRM's provider key ('prospectconnect', 'hoops', 'gorilladash'…) or 'haive'.
  @Prop()
  provider?: string;

  @Prop({ required: true, enum: ['deal', 'quote'] })
  entity: CrmActivityEntity;

  // The HaiVE record (crm_deals / crm_quotes _id).
  @Prop({ index: true })
  entityId?: string;

  @Prop()
  externalId?: string;

  @Prop({ required: true, enum: ['created', 'won', 'lost', 'reopened', 'sent', 'accepted', 'rejected'] })
  kind: CrmActivityKind;

  @Prop()
  fromStatus?: string;

  @Prop()
  toStatus?: string;

  // The deal's name, or the quotation's number.
  @Prop()
  ref?: string;

  @Prop()
  customerName?: string;

  @Prop()
  value?: number;

  @Prop()
  currency?: string;

  // A quotation's deal.
  @Prop()
  dealId?: string;

  @Prop()
  actorUserId?: string;

  // Prepared by the AI (e.g. a draft quotation written from a customer's
  // email), as opposed to done by hand — Team Performance tells the two apart.
  @Prop({ default: false })
  byAi: boolean;

  @Prop()
  crmOwnerRef?: string;

  @Prop()
  crmOwnerLabel?: string;

  @Prop({ required: true, enum: ['crm_sync', 'haive', 'backfill'] })
  origin: 'crm_sync' | 'haive' | 'backfill';

  @Prop({ required: true })
  occurredAt: Date;

  @Prop({ required: true, enum: ['crm', 'detected', 'closing_date', 'assumed', 'haive'] })
  occurredAtBasis: CrmActivityTimeBasis;

  @Prop({ required: true, unique: true })
  dedupeKey: string;

  createdAt: Date;
}

export const CrmActivitySchema = SchemaFactory.createForClass(CrmActivity);
CrmActivitySchema.index({ organizationId: 1, occurredAt: -1 });
CrmActivitySchema.index({ organizationId: 1, entity: 1, kind: 1, occurredAt: -1 });
