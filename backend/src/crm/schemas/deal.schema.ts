import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { dataSourceScopePlugin } from '../../data-sources/data-source-scope.plugin';

export type DealDocument = Deal & Document<Types.ObjectId>;

// stageId (pipeline position) and dealStatus (open/won/lost) are deliberately
// separate fields, not one — matches the dual-axis vocabulary python-agent's
// crm_deal_tool/sales_consultant persona already use.
@Schema({ timestamps: true, collection: 'crm_deals' })
export class Deal {
  @Prop({ required: true, index: true })
  organizationId: string;

  // The data source (CRM) this record came from — see
  // data-sources/schemas/data-source.schema.ts. Reads are scoped by it
  // automatically (dataSourceScopePlugin), so two CRMs' records never mix.
  @Prop({ index: true })
  dataSourceId?: string;

  @Prop()
  storeId?: string;

  // The sales rep this deal is assigned to — drives per-consultant
  // achievement % (see sales-analytics.service.ts). Always a real User._id
  // in THIS app — for a synced deal, set either by an admin's manual pick
  // (deals.controller.ts's assign endpoint) or automatically once a
  // DealOwnerMapping resolves externalOwnerRef below to a real user.
  @Prop({ index: true })
  ownerId?: string;

  // --- External CRM owner mapping (provider-agnostic) ---
  //
  // The raw owner/assigned-user identifier straight from whichever external
  // CRM this deal was synced from (e.g. ProspectConnect's own internal
  // "sales_person" id) — never assumed to correspond to anything in this
  // app on its own. A real user id space belonging to a DIFFERENT system;
  // resolving it into a trustworthy `ownerId` above requires an explicit
  // admin-configured DealOwnerMapping (see deal-owner-mapping.schema.ts),
  // since there's no reliable automatic cross-system identity match (a raw
  // external id has no inherent relationship to this app's own User._id
  // space). Every CRM integration's own sync script is responsible for
  // populating these three fields with ITS OWN provider's real field names
  // — the mapping/resolution layer above and the Settings → Deal Assignment
  // UI are entirely provider-agnostic from this point on, so adding a new
  // CRM (HubSpot, Zoho, Salesforce, ...) later needs no changes to either.
  @Prop({ index: true })
  externalOwnerRef?: string;

  // Best-effort human-readable label for externalOwnerRef (a name/email,
  // when the provider's API happens to return one alongside the raw id) —
  // shown in the mapping UI so an admin isn't asked to map a bare id string
  // blind. Never guaranteed non-null; the UI must fall back to the raw ref.
  // ProspectConnect's deal endpoint never returns a name directly (sales_person
  // is a bare id) — crm_mongo_sync.py populates this by cross-referencing the
  // same CRM user id against Quote.quoteOwnerLabel (see quote.schema.ts),
  // since the quotes endpoint DOES return a nested name for that same id
  // space. Left unset until at least one quote from that owner has synced.
  @Prop()
  externalOwnerLabel?: string;

  @Prop()
  externalOwnerProvider?: string;

  @Prop({ required: true })
  name: string;

  @Prop()
  contactId?: string;

  // Set only for deals mirrored in from an org's connected external CRM
  // (see python-agent/app/integrations/crm_mongo_sync.py) — the external
  // record's own id, so re-syncing updates the same document instead of
  // duplicating it. Absent for deals created natively.
  @Prop()
  externalId?: string;

  @Prop()
  accountId?: string;

  @Prop({ index: true })
  pipelineId?: string;

  @Prop()
  stageId?: string;

  @Prop({ enum: ['open', 'won', 'lost'], default: 'open' })
  dealStatus: 'open' | 'won' | 'lost';

  @Prop({ default: 0 })
  monetaryValue: number;

  // "YYYY-MM-DD" — also doubles as the period-attribution date for sales
  // analytics (a won deal counts toward the month it was expected to close).
  @Prop()
  expectedClosingDate?: string;

  // Phase 9a: manual-entry-only dimension fields for the Deal Performance
  // dashboard. crm_mongo_sync.py never populates these (the external CRM
  // doesn't expose them) — only natively created/edited deals carry real
  // values. Plain strings, not Mongoose `enum`, so a new category later
  // needs no schema migration (vocabulary is enforced at the DTO layer).
  @Prop()
  leadSource?: string;

  // Free-text, not a catalog relation — this app has no real product
  // catalog to link against (crm.service.ts's listProducts() is a stub).
  @Prop()
  product?: string;

  @Prop()
  customerType?: string;

  @Prop()
  region?: string;

  // Schema lands in Phase 9a; the capture dropdown UI and AI-inference
  // fallback land in Phase 9b — added together now so 9b needs no schema
  // migration of its own.
  @Prop()
  lostReason?: string;

  @Prop({ enum: ['rep_reported', 'ai_inferred'] })
  lostReasonSource?: 'rep_reported' | 'ai_inferred';

  // Set only by crm_mongo_sync.py, only when a genuine field value actually
  // changed (or the deal is newly synced) — NOT bumped on every unchanged
  // re-poll, since that sync writes via raw pymongo and never touches
  // Mongoose's own `updatedAt`. customer-activity.service.ts reads
  // `lastActivityAt ?? updatedAt` as its "when was this really touched"
  // signal: natively-created/edited deals (never synced) correctly fall
  // back to real Mongoose updatedAt; synced deals get accurate change-based
  // tracking instead of a blanket "always looks fresh" or "always looks
  // stale" false signal.
  @Prop()
  lastActivityAt?: Date;

  // Managed automatically by { timestamps: true } above — declared (not
  // @Prop()'d) purely so TypeScript knows these exist, same convention
  // DailyReport already uses. Phase 11's customer-activity.service.ts reads
  // these directly to determine "actioned today" / "new business".
  createdAt: Date;
  updatedAt: Date;
}

export const DealSchema = SchemaFactory.createForClass(Deal);
DealSchema.plugin(dataSourceScopePlugin);
DealSchema.index({ organizationId: 1, dataSourceId: 1 });
// One native Mongo doc per external deal per org. `sparse` alone does NOT
// achieve this for a COMPOUND index — Mongo only excludes a document from a
// sparse compound index when ALL of its fields are missing, and
// organizationId is never missing, so a plain `sparse: true` here silently
// allowed only ONE native (externalId-less) deal per org before ever
// colliding (found live during Phase 9a's create-endpoint verification,
// dormant since Phase 2). `partialFilterExpression` is the correct
// primitive: it excludes any document lacking externalId from the index
// entirely, regardless of what else is missing.
DealSchema.index({ organizationId: 1, dataSourceId: 1, externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $exists: true } } });
// Powers deal-owner-mapping.service.ts's "distinct unmapped external
// owners" listing and its bulk-apply-on-map update.
DealSchema.index({ organizationId: 1, externalOwnerRef: 1 }, { partialFilterExpression: { externalOwnerRef: { $exists: true } } });
