import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { dataSourceScopePlugin } from '../../data-sources/data-source-scope.plugin';

export type QuoteDocument = Quote & Document<Types.ObjectId>;

// Nested, not flattened — mirrors Finance's taxDetails/bankDetails
// convention. Populated only for synced quotes (from the external CRM's
// own client_details blob, confirmed live to carry a clean company_name +
// a real contact email — a materially better business-name/correlation
// source than deriving one from Deal.name). Left entirely unset for
// natively created quotes.
@Schema({ _id: false })
export class QuoteClientDetails {
  @Prop()
  companyName?: string;

  @Prop()
  contactName?: string;

  @Prop({ index: true })
  email?: string;

  @Prop()
  phone?: string;
}
const QuoteClientDetailsSchema = SchemaFactory.createForClass(QuoteClientDetails);

// Embedded line item — added for native (in-app) quote creation. Mirrors
// billing/schemas/billing-invoice.schema.ts's BillingInvoiceItem pattern
// (embedded, not a separate collection, since a quote's items are always
// read/rendered together with the quote itself). lineSubtotal/lineTotal are
// always server-computed by quote-pricing.util.ts — never trusted as
// client input. Left empty ([]) for synced and pre-existing quotes, which
// keep using the flat quoteAmount exactly as before.
@Schema({ _id: false })
export class QuoteLineItem {
  @Prop()
  productId?: string;

  @Prop({ required: true })
  description: string;

  @Prop({ required: true })
  quantity: number;

  @Prop({ required: true })
  unitPrice: number;

  @Prop({ default: 0 })
  discount: number;

  @Prop({ default: 0 })
  taxRate: number;

  @Prop({ required: true })
  lineSubtotal: number;

  @Prop({ required: true })
  lineTotal: number;
}
const QuoteLineItemSchema = SchemaFactory.createForClass(QuoteLineItem);

// quoteStatus (internal lifecycle) and clientApprovalStatus (client-facing
// approval state) are separate, independent axes — matches crm_quote_tool's
// existing vocabulary.
@Schema({ timestamps: true, collection: 'crm_quotes' })
export class Quote {
  @Prop({ required: true, index: true })
  organizationId: string;

  // The data source (CRM) this record came from — see
  // data-sources/schemas/data-source.schema.ts. Reads are scoped by it
  // automatically (dataSourceScopePlugin), so two CRMs' records never mix.
  @Prop({ index: true })
  dataSourceId?: string;

  @Prop({ index: true })
  dealId?: string;

  @Prop()
  quoteName?: string;

  @Prop({ default: 'draft' })
  quoteStatus: string;

  @Prop({ default: 'pending' })
  clientApprovalStatus: string;

  @Prop({ default: 0 })
  quoteAmount: number;

  @Prop({ default: 'USD' })
  currency: string;

  @Prop()
  expirationDate?: string;

  @Prop()
  quoteOwner?: string;

  // Best-effort human-readable label for quoteOwner — ProspectConnect's
  // quotes endpoint returns quote_owner as a nested {id, name, ...} profile
  // object (unlike deals, which only ever expose a bare sales_person id; see
  // deal.schema.ts's externalOwnerLabel comment). crm_mongo_sync.py captures
  // it here and cross-references it back onto Deal.externalOwnerLabel for
  // any deal sharing the same underlying CRM user id, since that's the only
  // place this integration ever receives a real name for that id space.
  @Prop()
  quoteOwnerLabel?: string;

  // Set only for quotes mirrored in from an org's connected external CRM
  // (see python-agent/app/integrations/crm_mongo_sync.py's sync_quotes_for_org)
  // — the external record's own id, so re-syncing updates the same document
  // instead of duplicating it. Absent for quotes created natively.
  @Prop()
  externalId?: string;

  // The one consistent "quote number" shown everywhere a quote is displayed.
  // Synced quotes: backfilled 1:1 from the external CRM's ticket_number.
  // Natively created quotes: auto-generated sequential "Q-0001" via
  // QuotesService's per-org counter. Left unset (never fabricated) if a
  // synced record has no ticket_number.
  @Prop({ index: true })
  quoteNumber?: string;

  @Prop({ type: QuoteClientDetailsSchema })
  clientDetails?: QuoteClientDetails;

  // Phase 14e — plain-text "what was requested" (e.g. "500 branded
  // T-shirts"), captured only for draft quotes QuotesService creates from an
  // Email Intelligence quotation_request. Never a price — quoteAmount stays
  // 0 for these until a human prices the quote for real.
  @Prop()
  requestNotes?: string;

  // See deal.schema.ts's identical field for why this exists — synced
  // quotes need change-aware activity tracking distinct from Mongoose's
  // updatedAt, which raw-pymongo sync writes never touch.
  @Prop()
  lastActivityAt?: Date;

  // --- Business Intelligence additions ---

  // Set only by EmailIntelligenceService.createDraftQuoteFromItem, going
  // forward from when this field was added — the real Enquiry->Quote
  // traceability link. Quotes created before this field existed (and
  // externally-synced quotes) have no value here; Enquiry Conversion
  // reporting must treat that as "no exact link", not "definitely not
  // enquiry-sourced" — see enquiry-conversion.service.ts's inferred-match
  // fallback.
  @Prop({ index: true })
  sourceEmailIntelligenceItemId?: string;

  // A real userId, distinct from quoteOwner above (free text, unreliable —
  // only trustworthy for email-drafted quotes). Populated from
  // CreateDraftQuoteInput.createdBy going forward. Historical/synced quotes
  // will lack this — Employee Productivity's quote stats must report
  // coveragePct honestly rather than silently undercounting as zero.
  @Prop({ index: true })
  ownerUserId?: string;

  // Payment-expectation date — distinct from expirationDate above, which is
  // quote *validity*, not when payment is due. Used for Accounts
  // Receivable aging buckets.
  @Prop()
  dueDate?: string;

  // Denormalized running total of non-voided QuotePayment.amount for this
  // quote — recomputed (not incrementally $inc'd, to avoid drift across
  // voids) by QuotePaymentsService on every payment create/void.
  // outstandingAmount is deliberately NOT stored: always computed live as
  // quoteAmount - paidAmount, matching finance-dashboard.service.ts's own
  // "never trust a stored value for something date/amount-derived" convention.
  @Prop({ default: 0 })
  paidAmount: number;

  // --- Native quote line items (additive) ---

  // Empty for every quote created before this field existed, and for
  // synced quotes (the external CRM never sends line items) — those keep
  // relying on the flat quoteAmount exactly as before. quoteAmount itself
  // continues to be the one "total" field for every quote, native or
  // synced — items just give a native quote's quoteAmount a real,
  // server-computed derivation instead of a hand-typed number.
  @Prop({ type: [QuoteLineItemSchema], default: [] })
  items: QuoteLineItem[];

  @Prop({ default: 0 })
  subtotal: number;

  @Prop({ default: 0 })
  discountAmount: number;

  @Prop({ default: 0 })
  taxAmount: number;

  // --- Hoops-parity SalesBoard (additive) ---
  //
  // Nine independent status axes (Phase 3 A-I of the spec) — each its own
  // free string governed by status-definitions (same convention as
  // quoteStatus/clientApprovalStatus above), never a shared field, and
  // never touched by SYNC_OWNED_FIELDS (quotes.service.ts) since none of
  // these concepts exist in any connected CRM — purely HaiVE's own
  // tracking layer, editable regardless of whether the quote is synced.
  @Prop()
  salesStatus?: string;

  @Prop()
  classification?: string;

  @Prop()
  paymentInvoiceStatus?: string;

  @Prop()
  orderStatus?: string;

  // A manual, hand-set label — independent of (and never overwritten by)
  // the computed paid/outstanding derived from quoteAmount/paidAmount
  // above, same separation Accounting Status keeps (computed only, never
  // stored — see quotes.service.ts's row-mapping).
  @Prop()
  paymentStatus?: string;

  @Prop()
  deliveryStatus?: string;

  @Prop()
  artworkStatus?: string;

  @Prop()
  productionReadyStatus?: string;

  @Prop()
  completedStatus?: string;

  // Soft references (org-scoped and validated at the service layer, same
  // convention as Product.vendorId) — Vendor has no distinct "production
  // house" type (confirmed: Vendor.category is free text), so this just
  // points at an ordinary Vendor the team treats as one.
  @Prop()
  productionHouseVendorId?: string;

  @Prop({ type: [String], default: [] })
  vendorIds: string[];

  // The Catalog's own Decoration price list (crm/schemas/decoration.schema.ts) — built
  // today for an unrelated task, reused here as the lookup this field points at.
  @Prop()
  decorationId?: string;

  // Per-quote "is this a brand-new customer or one we already do business
  // with" tag — deliberately its own field, not Customer.customerType
  // (which is the Business/Individual record-type added earlier today on
  // an entirely different document).
  @Prop()
  customerType?: string;

  // Distinct from expirationDate (quote validity) and dueDate (payment
  // expectation, reused as "Payment Deadline" — see quotes.service.ts's
  // row-mapping comment) — when the finished order itself is expected out
  // the door.
  @Prop()
  deliveryDate?: string;

  // One reference attachment per quote (GridFS — see
  // catalog-gridfs.service.ts's sibling pattern for the exact shape this
  // follows). Deliberately singular, matching every reference screenshot's
  // own "Reference" column; a quote needing more belongs on its Job once
  // converted, which already has real multi-file support.
  @Prop()
  referenceFileId?: string;

  @Prop()
  referenceFileName?: string;

  @Prop()
  referenceFileMimeType?: string;

  // Set once, at creation, by createQuote — never reassigned afterward
  // (ownerUserId above IS reassignable and serves as "Owner"; this is the
  // separate, immutable "Created By"). Quotes created before this field
  // existed, and every synced quote, correctly have no value here —
  // "Unknown", never a guess (the spec's own explicit requirement).
  @Prop()
  createdByUserId?: string;

  // Same archive-not-delete convention as customer_profiles.archived —
  // "Delete Quotation" in the UI archives; nothing calls deleteOne.
  @Prop({ default: false })
  archived: boolean;

  // The public Guest View link's own opaque token — regenerated (not
  // guessable from the quote's id/number), present only once "Copy Guest
  // View Link" has been used at least once. Its own expiry is
  // expirationDate above (the quote's real validity date), not a second,
  // invented one.
  @Prop()
  guestViewToken?: string;

  // Real, request-driven tracking — set only inside the public guest-view
  // route itself (quotes.controller.ts's guestView), never inferred from
  // an email send or any other action.
  @Prop()
  viewedAt?: Date;

  @Prop({ default: 0 })
  viewCount: number;

  // Managed automatically by { timestamps: true } above — see deal.schema.ts's
  // identical comment.
  createdAt: Date;
  updatedAt: Date;
}

export const QuoteSchema = SchemaFactory.createForClass(Quote);
QuoteSchema.plugin(dataSourceScopePlugin);
QuoteSchema.index({ organizationId: 1, dataSourceId: 1 });
// Same partialFilterExpression pattern as Deal's index — see deal.schema.ts's
// comment for why `sparse: true` alone is wrong for a compound unique index.
QuoteSchema.index({ organizationId: 1, dataSourceId: 1, externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $exists: true } } });
// One email should draft at most one quote — same partialFilterExpression
// idiom as externalId above (excludes every quote lacking this field from
// the index entirely, rather than colliding on "missing").
QuoteSchema.index(
  { organizationId: 1, sourceEmailIntelligenceItemId: 1 },
  { unique: true, partialFilterExpression: { sourceEmailIntelligenceItemId: { $exists: true } } },
);
