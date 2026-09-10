import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { Deal, DealDocument } from './schemas/deal.schema';
import { Product, ProductDocument } from './schemas/product.schema';
import { Quote, QuoteDocument } from './schemas/quote.schema';
import { QuoteCounter, QuoteCounterDocument } from './schemas/quote-counter.schema';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { UpdateQuoteDto } from './dto/update-quote.dto';
import { calculateQuoteTotals, validateQuoteItems } from './quote-pricing.util';

// Fields the external CRM sync owns exclusively (see crm_mongo_sync.py) —
// rejected outright (400) on any quote with externalId set, never a silent
// no-op, so a human edit can never be quietly clobbered by the next sync
// poll. Native (non-synced) quotes can still edit all four freely. 'items'
// was added alongside native quote creation — a synced quote never carries
// line items (the external CRM doesn't send them), so this is additive
// protection with zero behavior change for any quote that already had none.
const SYNC_OWNED_FIELDS = ['quoteAmount', 'clientApprovalStatus', 'quoteStatus', 'items'] as const;

export interface BiQuoteFilters {
  employeeId?: string[];
  storeId?: string[];
  clientApprovalStatus?: string[];
}

export interface CreateDraftQuoteInput {
  dealId?: string;
  businessName: string;
  contactEmail?: string;
  requestedItems?: string;
  createdBy: string;
  // Business Intelligence's Enquiry->Quote Conversion (section 4) — set only
  // by EmailIntelligenceService.createDraftQuoteFromItem, going forward from
  // when this field was added (see quote.schema.ts's own comment). The real
  // "exact" traceability link; absent means "no exact link", never
  // "definitely not enquiry-sourced" — enquiry-conversion.service.ts's
  // inferred-match fallback covers everything created before this existed.
  sourceEmailIntelligenceItemId?: string;
}

export interface ListQuotesFilter {
  dateFrom?: string;
  dateTo?: string;
  clientApprovalStatus?: string;
  page?: number;
  pageSize?: number;
}

// Phase 14e — the first real writer for QuoteCounter (landed dormant in
// Phase 11, never given logic). Only ever creates an honest, unpriced draft
// shell — quoteAmount is always 0 and never fabricated, matching this
// codebase's one unbroken "never invent a figure" convention.
@Injectable()
export class QuotesService {
  constructor(
    @InjectModel(Quote.name) private quoteModel: Model<QuoteDocument>,
    @InjectModel(QuoteCounter.name) private counterModel: Model<QuoteCounterDocument>,
    @InjectModel(Deal.name) private dealModel: Model<DealDocument>,
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
  ) {}

  // The first real "build a priced quote" entry point this app has had —
  // every other Quote writer (createDraftQuote, the external sync) either
  // never prices a quote or is owned entirely by the sync. dealId and every
  // line item's productId are validated against THIS org only — a
  // cross-org reference is a 400, never a silent cross-tenant read (same
  // principle as getOne's own scope check below). Totals are always
  // computed here, never trusted from the DTO (see quote-pricing.util.ts).
  async createQuote(organizationId: string, dto: CreateQuoteDto, createdBy: string, storeConstraint?: string): Promise<QuoteDocument> {
    if (dto.dealId) {
      const dealMatch: FilterQuery<Deal> = { _id: dto.dealId, organizationId, ...(storeConstraint ? { storeId: storeConstraint } : {}) };
      const deal = await this.dealModel.findOne(dealMatch).exec();
      if (!deal) throw new BadRequestException('Deal not found in this organization.');
    }

    const quoteCurrency = dto.currency ?? 'INR';
    const productIds = dto.items.map((i) => i.productId).filter((id): id is string => !!id);
    if (productIds.length > 0) {
      const products = await this.productModel.find({ _id: { $in: productIds }, organizationId }).exec();
      const foundIds = new Set(products.map((p) => p._id.toString()));
      const missing = productIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) throw new BadRequestException(`Product(s) not found in this organization: ${missing.join(', ')}`);
      const inactive = products.filter((p) => !p.isActive).map((p) => p.name);
      if (inactive.length > 0) throw new BadRequestException(`Cannot quote inactive product(s): ${inactive.join(', ')}`);
      this.assertProductCurrencyMatches(products, quoteCurrency);
    }

    validateQuoteItems(dto.items);
    const totals = calculateQuoteTotals(dto.items);
    const quoteNumber = await this.nextQuoteNumber(organizationId);

    return this.quoteModel.create({
      organizationId,
      dealId: dto.dealId,
      quoteName: dto.quoteName,
      quoteStatus: 'draft',
      clientApprovalStatus: 'pending',
      quoteAmount: totals.quoteAmount,
      currency: quoteCurrency,
      expirationDate: dto.expirationDate,
      dueDate: dto.dueDate,
      clientDetails: dto.clientDetails,
      requestNotes: dto.requestNotes,
      quoteNumber,
      ownerUserId: createdBy,
      items: totals.items,
      subtotal: totals.subtotal,
      discountAmount: totals.discountAmount,
      taxAmount: totals.taxAmount,
    });
  }

  // Phase 19 — Unified Analytics Dashboard's quote drill-down. Quote has no
  // storeId/ownerId of its own — store/personal scoping joins through the
  // linked Deal's own storeId/ownerId, same "resolve scoped deal ids first,
  // then match dealId $in" approach customer-activity.service.ts already
  // uses for its own personal-scope quote filtering. A quote with no dealId
  // can never be attributed to one specific store/consultant, so it's
  // correctly excluded once either constraint is set — never silently
  // included, matching that same established precedent.
  async listFiltered(
    organizationId: string,
    query: ListQuotesFilter,
    storeConstraint?: string,
    ownerConstraint?: string,
  ): Promise<{ items: QuoteDocument[]; total: number; page: number; pageSize: number }> {
    const match: FilterQuery<Quote> = { organizationId };

    if (query.dateFrom || query.dateTo) {
      match.createdAt = {
        ...(query.dateFrom ? { $gte: new Date(query.dateFrom) } : {}),
        // Explicit 'Z' (UTC) end-of-day — `.setHours()` mutates in the
        // server process's local timezone, which drifts hours off this
        // boundary on any server not running in UTC.
        ...(query.dateTo ? { $lte: new Date(`${query.dateTo}T23:59:59.999Z`) } : {}),
      };
    }
    // Same boolean split the analytics-dashboard's quote-acceptance donut
    // uses ($eq: ['$clientApprovalStatus', 'approved']) — 'not-approved'
    // means "everything else", not one specific literal string, so the
    // drill-down list's total always matches the donut's own count exactly.
    if (query.clientApprovalStatus === 'approved') match.clientApprovalStatus = 'approved';
    else if (query.clientApprovalStatus === 'not-approved') match.clientApprovalStatus = { $ne: 'approved' };

    if (storeConstraint || ownerConstraint) {
      const dealMatch: FilterQuery<Deal> = {
        organizationId,
        ...(storeConstraint ? { storeId: storeConstraint } : {}),
        ...(ownerConstraint ? { ownerId: ownerConstraint } : {}),
      };
      const deals = await this.dealModel.find(dealMatch).select({ _id: 1 }).exec();
      match.dealId = { $in: deals.map((d) => d._id.toString()) };
    }

    const page = query.page ?? 1;
    const pageSize = Math.min(query.pageSize ?? 25, 100);
    const [items, total] = await Promise.all([
      this.quoteModel
        .find(match)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .exec(),
      this.quoteModel.countDocuments(match).exec(),
    ]);
    return { items, total, page, pageSize };
  }

  async createDraftQuote(organizationId: string, input: CreateDraftQuoteInput): Promise<QuoteDocument> {
    const quoteNumber = await this.nextQuoteNumber(organizationId);
    return this.quoteModel.create({
      organizationId,
      dealId: input.dealId,
      quoteName: input.requestedItems ? input.requestedItems.slice(0, 120) : `Draft quote for ${input.businessName}`,
      quoteStatus: 'draft',
      quoteAmount: 0,
      currency: 'INR',
      quoteOwner: input.createdBy,
      // Real userId, distinct from quoteOwner (free text) — see
      // quote.schema.ts's own comment. createDraftQuote is the only Quote
      // writer today, so this is the one place ownerUserId gets populated
      // going forward.
      ownerUserId: input.createdBy,
      quoteNumber,
      clientDetails: { companyName: input.businessName, email: input.contactEmail },
      requestNotes: input.requestedItems,
      sourceEmailIntelligenceItemId: input.sourceEmailIntelligenceItemId,
    });
  }

  private async nextQuoteNumber(organizationId: string): Promise<string> {
    const counter = await this.counterModel
      .findOneAndUpdate({ organizationId }, { $inc: { seq: 1 } }, { upsert: true, new: true })
      .exec();
    return `Q-${String(counter.seq).padStart(4, '0')}`;
  }

  // A quote must never contain a product priced in a different currency
  // than the quote itself (never silently converted or mixed — reject
  // outright). Shared by createQuote and updateQuote, run against the same
  // already-fetched `products` array those callers use for the
  // missing/inactive checks, so this adds no extra query.
  private assertProductCurrencyMatches(products: ProductDocument[], quoteCurrency: string): void {
    const mismatched = products.filter((p) => p.currency !== quoteCurrency).map((p) => `${p.name} (${p.currency})`);
    if (mismatched.length > 0) {
      throw new BadRequestException(
        `Product currency must match the quote currency (${quoteCurrency}). Mismatched: ${mismatched.join(', ')}`,
      );
    }
  }

  // Business Intelligence's Employee Productivity (section 3) — grouped by
  // the real ownerUserId (not quoteOwner, free text). ownerUserId only
  // started being populated once this field existed (see createDraftQuote
  // above), so coveragePct is always surfaced alongside the per-employee
  // rows rather than silently treating unattributed quotes as zero — same
  // honesty convention as deal-performance-dashboard.service.ts's own
  // getBreakdown coverage reporting.
  async getConsultantQuoteStats(
    organizationId: string,
    start: Date,
    end: Date,
    roster: { userId: string; userName: string }[],
  ): Promise<{ rows: ConsultantQuoteStatsRow[]; coveragePct: number | null }> {
    const rosterIds = roster.map((r) => r.userId);
    const dateMatch: FilterQuery<Quote> = { organizationId, createdAt: { $gte: start, $lt: end } };

    const [totalInRange, attributedInRange, quotes] = await Promise.all([
      this.quoteModel.countDocuments(dateMatch).exec(),
      this.quoteModel.countDocuments({ ...dateMatch, ownerUserId: { $exists: true, $ne: null } }).exec(),
      this.quoteModel
        .find({ ...dateMatch, ownerUserId: { $in: rosterIds } })
        .select({ ownerUserId: 1, clientApprovalStatus: 1, expirationDate: 1 })
        .exec(),
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const byOwner = new Map<string, { assigned: number; completed: number; pending: number; overdue: number }>();
    for (const q of quotes) {
      const uid = q.ownerUserId!;
      const entry = byOwner.get(uid) ?? { assigned: 0, completed: 0, pending: 0, overdue: 0 };
      entry.assigned += 1;
      if (q.clientApprovalStatus === 'approved') entry.completed += 1;
      else if (q.expirationDate && q.expirationDate < today) entry.overdue += 1;
      else entry.pending += 1;
      byOwner.set(uid, entry);
    }

    const rows = roster.map((r) => {
      const stats = byOwner.get(r.userId) ?? { assigned: 0, completed: 0, pending: 0, overdue: 0 };
      return { userId: r.userId, userName: r.userName, ...stats };
    });

    return {
      rows,
      coveragePct: totalInRange > 0 ? Math.round((attributedInRange / totalInRange) * 1000) / 10 : null,
    };
  }

  // Section 7's write endpoints and the BI reporting endpoints both need a
  // single org+scope-checked quote fetch — same "resolve scoped deal ids
  // first" join listFiltered already uses, applied to one record. A quote
  // with no dealId can never be attributed to a specific store/consultant,
  // so it's correctly excluded once either constraint is set (404, not a
  // silent pass) — same precedent as listFiltered's own comment.
  // Vendor Profitability's Vendor Quote <-> Customer Quote linking (Finance
  // AI "Customer Quote No" field) — the one search this app never needed
  // before, since every prior Quote consumer already had a dealId/quoteId in
  // hand. Case-insensitive exact match (a human retyping "IN001" from a PDF
  // may not match stored case), org-scoped, capped at 10 — this feeds a
  // confirmation UI a person reviews, never an auto-pick.
  async findByQuoteNumber(organizationId: string, quoteNumber: string): Promise<QuoteDocument[]> {
    const trimmed = quoteNumber.trim();
    if (!trimmed) return [];
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return this.quoteModel
      .find({ organizationId, quoteNumber: { $regex: `^${escaped}$`, $options: 'i' } })
      .sort({ createdAt: -1 })
      .limit(10)
      .exec();
  }

  async getOne(organizationId: string, id: string, storeConstraint?: string, ownerConstraint?: string): Promise<QuoteDocument> {
    const quote = await this.quoteModel.findOne({ _id: id, organizationId }).exec();
    if (!quote) throw new NotFoundException('Quote not found');

    if (storeConstraint || ownerConstraint) {
      if (!quote.dealId) throw new NotFoundException('Quote not found');
      const dealMatch: FilterQuery<Deal> = {
        _id: quote.dealId,
        organizationId,
        ...(storeConstraint ? { storeId: storeConstraint } : {}),
        ...(ownerConstraint ? { ownerId: ownerConstraint } : {}),
      };
      const deal = await this.dealModel.findOne(dealMatch).exec();
      if (!deal) throw new NotFoundException('Quote not found');
    }
    return quote;
  }

  // The only quote-editing path this app has (see plan finding #3 — Quote
  // was 100% read-only from NestJS before this). Checked in this order:
  // scope (404 if out of reach) THEN the sync-owned-field guard (400) THEN
  // the actual write — a manager probing a quote outside their store must
  // never learn anything about it, not even that it's synced.
  async updateQuote(organizationId: string, id: string, dto: UpdateQuoteDto, storeConstraint?: string): Promise<QuoteDocument> {
    const quote = await this.getOne(organizationId, id, storeConstraint);

    if (quote.externalId) {
      const attempted = SYNC_OWNED_FIELDS.filter((f) => dto[f] !== undefined);
      if (attempted.length > 0) {
        throw new BadRequestException(
          `Cannot edit ${attempted.join(', ')} on a quote synced from the external CRM — the sync owns these fields.`,
        );
      }
    }

    if (dto.dealId) {
      const dealMatch: FilterQuery<Deal> = { _id: dto.dealId, organizationId, ...(storeConstraint ? { storeId: storeConstraint } : {}) };
      const deal = await this.dealModel.findOne(dealMatch).exec();
      if (!deal) throw new BadRequestException('Deal not found in this organization.');
    }

    const { items, ...rest } = dto;
    Object.assign(quote, rest);

    // Recalculated here, never trusted from the client — same validation +
    // productId/org check createQuote runs, so an edited line item can
    // never quietly bypass the rules a newly-created one is held to.
    if (items) {
      const productIds = items.map((i) => i.productId).filter((pid): pid is string => !!pid);
      if (productIds.length > 0) {
        const products = await this.productModel.find({ _id: { $in: productIds }, organizationId }).exec();
        const foundIds = new Set(products.map((p) => p._id.toString()));
        const missing = productIds.filter((pid) => !foundIds.has(pid));
        if (missing.length > 0) throw new BadRequestException(`Product(s) not found in this organization: ${missing.join(', ')}`);
        const inactive = products.filter((p) => !p.isActive).map((p) => p.name);
        if (inactive.length > 0) throw new BadRequestException(`Cannot quote inactive product(s): ${inactive.join(', ')}`);
        // quote.currency already reflects dto.currency at this point (see
        // Object.assign(quote, rest) above), so a request that changes both
        // the quote's currency and its items in one PATCH is checked against
        // the NEW currency, not the stale one.
        this.assertProductCurrencyMatches(products, quote.currency);
      }

      validateQuoteItems(items);
      const totals = calculateQuoteTotals(items);
      quote.items = totals.items;
      quote.subtotal = totals.subtotal;
      quote.discountAmount = totals.discountAmount;
      quote.taxAmount = totals.taxAmount;
      quote.quoteAmount = totals.quoteAmount;
    }

    await quote.save();
    return quote;
  }

  // Business Intelligence's Customer Quote & Payment Tracking (section 7).
  // Paginated list — same store-scoping join as listFiltered, extended with
  // employeeId (ownerUserId, real userId — see quote.schema.ts) and
  // multi-value clientApprovalStatus for the BI global filter bar.
  async listForBi(
    organizationId: string,
    start: Date,
    end: Date,
    filters: BiQuoteFilters,
    page: number,
    pageSize: number,
  ): Promise<{ items: QuoteDocument[]; total: number; page: number; pageSize: number }> {
    const match = await this.buildBiMatch(organizationId, start, end, filters);
    const [items, total] = await Promise.all([
      this.quoteModel
        .find(match)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .exec(),
      this.quoteModel.countDocuments(match).exec(),
    ]);
    return { items, total, page, pageSize };
  }

  // accepted/rejected/pending counts+value, paid/outstanding sums, and live
  // aging buckets — never stored, always computed from quoteAmount/
  // paidAmount/dueDate vs. today, same "never trust a stored value for
  // something date/amount-derived" convention as finance-dashboard.service.ts.
  // A quote with no dueDate can't honestly be aged, so its outstanding
  // balance is reported separately (noDueDate), never silently folded into
  // "current".
  async getBiSummary(
    organizationId: string,
    start: Date,
    end: Date,
    filters: BiQuoteFilters,
  ): Promise<{
    byStatus: { status: string; count: number; value: number }[];
    totalQuoted: number;
    totalPaid: number;
    totalOutstanding: number;
    agingBuckets: { bucket: string; amount: number }[];
  }> {
    const match = await this.buildBiMatch(organizationId, start, end, filters);
    const [statusRows, quotes] = await Promise.all([
      this.quoteModel
        .aggregate<{ _id: string; count: number; value: number }>([
          { $match: match },
          { $group: { _id: '$clientApprovalStatus', count: { $sum: 1 }, value: { $sum: '$quoteAmount' } } },
        ])
        .exec(),
      this.quoteModel.find(match).select({ quoteAmount: 1, paidAmount: 1, dueDate: 1 }).exec(),
    ]);

    const today = Date.now();
    const buckets = { current: 0, '1-30': 0, '31-60': 0, '60+': 0, noDueDate: 0 };
    let totalQuoted = 0;
    let totalPaid = 0;
    for (const q of quotes) {
      totalQuoted += q.quoteAmount;
      totalPaid += q.paidAmount;
      const outstanding = q.quoteAmount - q.paidAmount;
      if (outstanding <= 0) continue;
      if (!q.dueDate) {
        buckets.noDueDate += outstanding;
        continue;
      }
      const daysPast = Math.floor((today - new Date(`${q.dueDate}T00:00:00.000Z`).getTime()) / 86_400_000);
      if (daysPast <= 0) buckets.current += outstanding;
      else if (daysPast <= 30) buckets['1-30'] += outstanding;
      else if (daysPast <= 60) buckets['31-60'] += outstanding;
      else buckets['60+'] += outstanding;
    }

    return {
      byStatus: statusRows.map((r) => ({ status: r._id, count: r.count, value: r.value })),
      totalQuoted,
      totalPaid,
      totalOutstanding: totalQuoted - totalPaid,
      agingBuckets: Object.entries(buckets).map(([bucket, amount]) => ({ bucket, amount })),
    };
  }

  // "Dues" for Agent Activity's team-wide view (analytics-dashboard.service.ts)
  // — what each owner currently has outstanding, right now. Deliberately NOT
  // date-range scoped like getBiSummary above: a quote created last quarter
  // that's still unpaid is still a real due today, not something that should
  // disappear once its creation month rolls out of the selected reporting
  // period. Mirrors getOpenDealAgingByOwner's per-owner Map shape/style.
  async getOutstandingByOwner(organizationId: string): Promise<Map<string, number>> {
    const rows = await this.quoteModel
      .aggregate<{ _id: string; totalQuoted: number; totalPaid: number }>([
        { $match: { organizationId, ownerUserId: { $exists: true, $ne: null } } },
        { $group: { _id: '$ownerUserId', totalQuoted: { $sum: '$quoteAmount' }, totalPaid: { $sum: '$paidAmount' } } },
      ])
      .exec();

    return new Map(rows.map((r) => [r._id, r.totalQuoted - r.totalPaid]));
  }

  private async buildBiMatch(organizationId: string, start: Date, end: Date, filters: BiQuoteFilters): Promise<FilterQuery<Quote>> {
    const match: FilterQuery<Quote> = { organizationId, createdAt: { $gte: start, $lt: end } };
    if (filters.employeeId?.length) match.ownerUserId = { $in: filters.employeeId };
    if (filters.clientApprovalStatus?.length) match.clientApprovalStatus = { $in: filters.clientApprovalStatus };
    if (filters.storeId?.length) {
      const deals = await this.dealModel.find({ organizationId, storeId: { $in: filters.storeId } }).select({ _id: 1 }).exec();
      match.dealId = { $in: deals.map((d) => d._id.toString()) };
    }
    return match;
  }

  // Business Intelligence's AI Follow-Up Summary (section 6) — org-wide,
  // unfiltered (matches FinanceSummaryService's own "cache key has no
  // filter dimension" precedent), capped, real-only: still outstanding
  // (quoteAmount > paidAmount) with a dueDate that has passed. A quote with
  // no dueDate is never counted as overdue — an unset date can't honestly
  // be judged late (same principle as getBiSummary's own aging buckets).
  async listOverdueForOrg(organizationId: string, limit = 20): Promise<
    { quoteId: string; quoteNumber?: string; businessName?: string; quoteAmount: number; outstandingAmount: number; dueDate: string }[]
  > {
    const today = new Date().toISOString().slice(0, 10);
    const quotes = await this.quoteModel
      .find({ organizationId, dueDate: { $lt: today }, $expr: { $gt: ['$quoteAmount', '$paidAmount'] } })
      .sort({ dueDate: 1 })
      .limit(limit)
      .exec();

    return quotes.map((q) => ({
      quoteId: q._id.toString(),
      quoteNumber: q.quoteNumber,
      businessName: q.clientDetails?.companyName ?? q.quoteName,
      quoteAmount: q.quoteAmount,
      outstandingAmount: q.quoteAmount - q.paidAmount,
      dueDate: q.dueDate!,
    }));
  }
}

export interface ConsultantQuoteStatsRow {
  userId: string;
  userName: string;
  assigned: number;
  completed: number;
  pending: number;
  overdue: number;
}
