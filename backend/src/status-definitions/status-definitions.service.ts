import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { StatusDefinition, StatusDefinitionDocument } from './schemas/status-definition.schema';

interface DefaultStatus {
  key: string;
  label: string;
  color: string;
}

@Injectable()
export class StatusDefinitionsService {
  // The only fields this phase knows about — a fixed allow-list, not any
  // caller-supplied string: a typo'd field name would otherwise silently
  // never match anything a board renders, and a field nothing reads yet
  // would be inert. Each list's `key` is exactly the value already stored
  // on the Deal/Quote document today (Deal.dealStatus is a real Mongoose
  // enum; Quote.clientApprovalStatus's only two real values, confirmed by
  // grep across every reader of that field, are 'pending'/'approved' —
  // never a guessed third value like 'rejected').
  private readonly defaultsByField: Record<string, DefaultStatus[]> = {
    'deal.dealStatus': [
      { key: 'open', label: 'Open', color: '#6b7280' },
      { key: 'won', label: 'Won', color: '#16a34a' },
      { key: 'lost', label: 'Lost', color: '#dc2626' },
    ],
    'quote.clientApprovalStatus': [
      { key: 'pending', label: 'Pending', color: '#6b7280' },
      { key: 'approved', label: 'Approved', color: '#16a34a' },
    ],
    // Added for the SalesBoard (Hoops-parity Phase 2) — the three real
    // values, confirmed by the same grep quotes.service.ts's own
    // ListQuotesFilter comment cites; no new key invented.
    'quote.quoteStatus': [
      { key: 'draft', label: 'Draft', color: '#6b7280' },
      { key: 'published', label: 'Published', color: '#2563eb' },
      { key: 'sent', label: 'Sent', color: '#16a34a' },
    ],
    // Added for the SalesBoard (Hoops-parity Phase 3, categories A-I) — nine
    // independent axes with no pre-existing enum to reflect (unlike the
    // three entries above), since the spec requests these as brand-new
    // HaiVE-native concepts. Every label/color below is a starting default
    // only — exactly like every other entry here, an admin can relabel any
    // key via relabel() with zero code changes, so wording is never locked in.
    'quote.salesStatus': [
      { key: 'open', label: 'Open', color: '#6b7280' },
      { key: 'quoted', label: 'Quoted', color: '#2563eb' },
      { key: 'negotiating', label: 'Negotiating', color: '#d97706' },
      { key: 'won', label: 'Won', color: '#16a34a' },
      { key: 'lost', label: 'Lost', color: '#dc2626' },
    ],
    'quote.classification': [
      { key: 'standard', label: 'Standard', color: '#6b7280' },
      { key: 'rush', label: 'Rush', color: '#dc2626' },
      { key: 'reorder', label: 'Reorder', color: '#2563eb' },
      { key: 'sample', label: 'Sample', color: '#7c3aed' },
    ],
    'quote.paymentInvoiceStatus': [
      { key: 'not_invoiced', label: 'Not Invoiced', color: '#6b7280' },
      { key: 'invoiced', label: 'Invoiced', color: '#2563eb' },
      { key: 'partially_paid', label: 'Partially Paid', color: '#d97706' },
      { key: 'paid', label: 'Paid', color: '#16a34a' },
    ],
    'quote.orderStatus': [
      { key: 'pending', label: 'Pending', color: '#6b7280' },
      { key: 'confirmed', label: 'Confirmed', color: '#2563eb' },
      { key: 'in_production', label: 'In Production', color: '#d97706' },
      { key: 'shipped', label: 'Shipped', color: '#0891b2' },
      { key: 'delivered', label: 'Delivered', color: '#16a34a' },
      { key: 'cancelled', label: 'Cancelled', color: '#dc2626' },
    ],
    'quote.paymentStatus': [
      { key: 'unpaid', label: 'Unpaid', color: '#6b7280' },
      { key: 'partially_paid', label: 'Partially Paid', color: '#d97706' },
      { key: 'paid', label: 'Paid', color: '#16a34a' },
      { key: 'refunded', label: 'Refunded', color: '#dc2626' },
    ],
    'quote.deliveryStatus': [
      { key: 'not_shipped', label: 'Not Shipped', color: '#6b7280' },
      { key: 'processing', label: 'Processing', color: '#d97706' },
      { key: 'shipped', label: 'Shipped', color: '#0891b2' },
      { key: 'delivered', label: 'Delivered', color: '#16a34a' },
      { key: 'delayed', label: 'Delayed', color: '#dc2626' },
    ],
    'quote.artworkStatus': [
      { key: 'not_started', label: 'Not Started', color: '#6b7280' },
      { key: 'awaiting_approval', label: 'Awaiting Approval', color: '#d97706' },
      { key: 'approved', label: 'Approved', color: '#16a34a' },
      { key: 'revision_requested', label: 'Revision Requested', color: '#dc2626' },
    ],
    'quote.productionReadyStatus': [
      { key: 'not_ready', label: 'Not Ready', color: '#6b7280' },
      { key: 'ready', label: 'Ready', color: '#2563eb' },
      { key: 'in_progress', label: 'In Progress', color: '#d97706' },
      { key: 'complete', label: 'Complete', color: '#16a34a' },
    ],
    'quote.completedStatus': [
      { key: 'not_completed', label: 'Not Completed', color: '#6b7280' },
      { key: 'completed', label: 'Completed', color: '#16a34a' },
      { key: 'completed_late', label: 'Completed Late', color: '#d97706' },
    ],
  };

  constructor(@InjectModel(StatusDefinition.name) private model: Model<StatusDefinitionDocument>) {}

  private defaultsFor(field: string): DefaultStatus[] {
    const defaults = this.defaultsByField[field];
    if (!defaults) throw new BadRequestException(`Unknown status field '${field}'.`);
    return defaults;
  }

  /** Idempotent, race-safe: each default key is upserted independently via
   * $setOnInsert, so this never overwrites an admin's existing label/color
   * customization, and calling it concurrently from two requests never
   * creates a duplicate row (the unique index + upsert make each insert
   * atomic) — the same pattern every OAuth-credential upsert in this
   * codebase already relies on. */
  private async ensureSeeded(organizationId: string, field: string): Promise<void> {
    const defaults = this.defaultsFor(field);
    await Promise.all(
      defaults.map((d, index) =>
        this.model
          .findOneAndUpdate(
            { organizationId, field, key: d.key },
            { $setOnInsert: { label: d.label, color: d.color, order: index, active: true } },
            { upsert: true },
          )
          .exec(),
      ),
    );
  }

  async list(organizationId: string, field: string): Promise<StatusDefinitionDocument[]> {
    this.defaultsFor(field); // validates field, throws BadRequestException if unknown
    await this.ensureSeeded(organizationId, field);
    return this.model.find({ organizationId, field }).sort({ order: 1 }).exec();
  }

  /** Changes how an EXISTING status displays — never creates a new one.
   * Rejects a key that isn't already seeded/known, matching this phase's
   * deliberate scope (see status-definition.schema.ts's own comment). */
  async relabel(
    organizationId: string,
    field: string,
    key: string,
    update: { label?: string; color?: string },
  ): Promise<StatusDefinitionDocument> {
    this.defaultsFor(field);
    await this.ensureSeeded(organizationId, field);
    const set: Record<string, string> = {};
    if (update.label !== undefined) set.label = update.label;
    if (update.color !== undefined) set.color = update.color;

    const doc = await this.model.findOneAndUpdate({ organizationId, field, key }, { $set: set }, { new: true }).exec();
    if (!doc) {
      throw new NotFoundException(
        `'${key}' is not a known status for '${field}' — only an existing status can be relabeled this phase.`,
      );
    }
    return doc;
  }
}
