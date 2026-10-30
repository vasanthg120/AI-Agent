import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type DealOwnerMappingDocument = DealOwnerMapping & Document<Types.ObjectId>;

// The configurable half of deal-owner resolution — see deal.schema.ts's own
// comment on externalOwnerRef for the full picture. One row per (org,
// provider, raw external owner id), pointing at a real internal User._id.
// Provider-agnostic by construction: a future HubSpot/Zoho/Salesforce sync
// only needs to populate Deal.externalOwnerRef/externalOwnerProvider with
// its own real field names — this schema, the resolution/bulk-apply logic,
// and the Settings → Deal Assignment mapping UI all stay unchanged.
@Schema({ timestamps: true, collection: 'crm_deal_owner_mappings' })
export class DealOwnerMapping {
  @Prop({ required: true, index: true })
  organizationId: string;

  // e.g. 'prospectconnect' today; 'hubspot' | 'zoho' | 'salesforce' once
  // those integrations exist — free text, not a Mongoose enum, so adding a
  // new provider is a data change, never a schema migration.
  @Prop({ required: true })
  provider: string;

  @Prop({ required: true })
  externalOwnerRef: string;

  // Snapshot of Deal.externalOwnerLabel at the time this mapping was saved
  // — purely informational (re-displaying the mapping later without a
  // second lookup), never authoritative over whatever the sync currently sees.
  @Prop()
  externalOwnerLabel?: string;

  // The single auto-assignable owner when linkedUserIds (below) has exactly
  // one entry — undefined when more than one user is linked (ambiguous: no
  // deal-specific signal says which of them a given deal belongs to, see
  // deal-owner-mapping.service.ts's own upsertMapping comment). Every
  // existing single-user mapping already has this set and is completely
  // unaffected — it only ever becomes undefined for a NEWLY created
  // multi-user mapping. Changed from required to optional for this reason;
  // no migration needed, since every row ever written before this existed
  // already satisfies "exactly one entry" by construction.
  @Prop({ index: true })
  ownerId?: string;

  // Every HaiVE user associated with this external salesperson — the full
  // set an admin has linked (1 or more; see DealOwnerMappingService's own
  // comment on why "linked" is an association, not automatic ownership).
  // Always equals [ownerId] when ownerId is set. Absent/empty on any row
  // written before this field existed — callers must treat that the same
  // as [ownerId] (see DealOwnerMappingService.listExternalOwners), never as
  // "no linked users at all" for a row that plainly has an ownerId.
  @Prop({ type: [String], default: [] })
  linkedUserIds: string[];

  @Prop({ required: true })
  mappedBy: string;

  createdAt: Date;
  updatedAt: Date;
}

export const DealOwnerMappingSchema = SchemaFactory.createForClass(DealOwnerMapping);
// One mapping per (org, provider, external owner) — saving again for the
// same triple updates the existing row (see the service's upsert), never
// creates a duplicate.
DealOwnerMappingSchema.index({ organizationId: 1, provider: 1, externalOwnerRef: 1 }, { unique: true });
