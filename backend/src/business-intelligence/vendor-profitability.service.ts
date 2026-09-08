import { HttpService } from '@nestjs/axios';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { Deal, DealDocument } from '../crm/schemas/deal.schema';
import { Quote, QuoteDocument } from '../crm/schemas/quote.schema';
import { QuotePaymentsService } from '../crm/quote-payments.service';
import { QuotePaymentDocument } from '../crm/schemas/quote-payment.schema';
import { FinanceDocument, FinanceDocumentDocument } from '../finance/schemas/finance-document.schema';
import { Vendor, VendorDocument } from '../vendors/schemas/vendor.schema';
import { VendorQuote, VendorQuoteDocument } from '../vendors/schemas/vendor-quote.schema';

export interface VendorProfitabilityFilters {
  vendorId?: string[];
}

export interface VendorProfitabilityRow {
  dealId: string;
  dealName?: string;
  vendorNames: string[];
  // Expected/agreed vendor cost — every non-cancelled linked FinanceDocument
  // for this deal, regardless of paymentStatus. This is the cost basis
  // gross profit/margin/markup are computed from (see the module comment
  // below for why payment status must never gate profitability).
  vendorCost: number;
  // Actual cash paid so far — the subset of the above with paymentStatus
  // paid/partially_paid. This is what the OLD `vendorCost` used to mean;
  // kept as its own field so "how much have I actually paid" is never lost.
  actualVendorCostPaid: number;
  vendorCostCurrency: string;
  customerRevenue: number;
  customerRevenueCurrency: string;
  customerPaid: number;
  grossProfit: number | null;
  grossMarginPct: number | null;
  // Gross Profit / Vendor Cost x 100 — a distinct figure from margin
  // (Gross Profit / Customer Revenue x 100). Never confuse the two.
  markupPct: number | null;
  currencyMismatch: boolean;
  vendorQuoteCount: number;
  quoteCount: number;
  // Collapsed 3-way summary across every linked FinanceDocument for this
  // deal — 'paid' only if ALL are paid, 'pending' only if NONE have any
  // money against them yet, 'partially_paid' otherwise.
  vendorPaymentStatus: 'paid' | 'partially_paid' | 'pending';
  // Same 3-way vocabulary, derived from the customer side (customerPaid vs
  // customerRevenue) — a completely independent number from the vendor side
  // above; the two are never conflated.
  customerPaymentStatus: 'paid' | 'partially_paid' | 'pending';
  vendorQuoteNumbers: string[];
  customerQuoteNo?: string;
}

// Section 5 — Accounts Receivable & Vendor Profitability Analysis. Per-
// transaction row keyed by dealId: Customer Quote (quoteAmount = revenue) on
// one side, every linked vendor-payment FinanceDocument on the other ->
// Gross Profit. No Net Profit field (no overhead/commission/royalty-fee
// deduction model exists anywhere in this app — shipping that would be
// fabricating a number, not reporting one).
//
// Profitability is deliberately independent of vendor payment status —
// vendorCost above is the AGREED/quoted amount (what you committed to pay
// the vendor), not what's actually left your bank account yet. A deal whose
// vendor invoice is still "pending" has a real, known cost the moment that
// invoice exists; waiting for it to be paid before recognizing it would make
// Gross Profit swing from a real number to a fabricated ₹0-cost number for
// no reason tied to the actual deal. Finance AI's own dashboard
// (finance-dashboard.service.ts) is the correct, unchanged place for
// cash-basis reporting (paid/pending/overdue/upcoming) — actualVendorCostPaid
// on each row exists so that view is never lost here either, just never
// used to gate whether a deal counts as profitable.
//
// Every FinanceDocument/Quote/VendorQuote is unset for dealId/vendorRef on
// every pre-existing record (no backfill path — see finance-document.schema.ts's
// own comment), so this will show a small/near-empty dataset until users
// link new records going forward. coveragePct is always surfaced, never
// silently implied as complete.
@Injectable()
export class VendorProfitabilityService {
  private readonly pythonAgentUrl: string;

  constructor(
    @InjectModel(FinanceDocument.name) private financeDocumentModel: Model<FinanceDocumentDocument>,
    @InjectModel(Quote.name) private quoteModel: Model<QuoteDocument>,
    @InjectModel(Deal.name) private dealModel: Model<DealDocument>,
    @InjectModel(Vendor.name) private vendorModel: Model<VendorDocument>,
    @InjectModel(VendorQuote.name) private vendorQuoteModel: Model<VendorQuoteDocument>,
    private quotePaymentsService: QuotePaymentsService,
    private http: HttpService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {
    this.pythonAgentUrl = this.config.get<string>('pythonAgentUrl') ?? 'http://localhost:8000';
  }

  // Stateless, on-demand only — no cache (unlike AiFollowupSummaryService's
  // daily snapshot), scoped to whatever filtered rows the caller is
  // currently viewing. Takes the already-computed rows directly (never
  // recomputes them) so the AI commentary can never disagree with the
  // deterministic numbers already on screen.
  async requestAiComparison(caller: JwtPayload, rows: VendorProfitabilityRow[]): Promise<Record<string, unknown>> {
    const token = this.jwt.sign({ sub: caller.sub, organizationId: caller.organizationId }, { expiresIn: '5m' });
    const payload = {
      transactions: rows
        .filter((r) => !r.currencyMismatch)
        .map((r) => ({
          dealId: r.dealId,
          dealName: r.dealName,
          vendorCost: r.vendorCost,
          customerRevenue: r.customerRevenue,
          grossProfit: r.grossProfit,
          grossMarginPct: r.grossMarginPct,
        })),
    };
    const { data } = await firstValueFrom(
      this.http.post<Record<string, unknown>>(`${this.pythonAgentUrl}/business-intelligence/vendor-profitability/compare`, payload, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    return data;
  }

  async getOverview(
    organizationId: string,
    start: Date,
    end: Date,
    filters: VendorProfitabilityFilters,
  ): Promise<{
    rows: VendorProfitabilityRow[];
    totals: {
      customerRevenue: number;
      vendorCost: number;
      actualVendorCostPaid: number;
      grossProfit: number;
      grossMarginPct: number | null;
      markupPct: number | null;
    };
    coveragePct: number | null;
    currencyMismatchCount: number;
  }> {
    // A deal's cost basis includes every non-cancelled linked vendor
    // invoice, regardless of paymentStatus (pending/overdue/partially_paid/
    // paid all represent a real, agreed cost) — only 'cancelled' genuinely
    // never happened. Payment-status-specific cash figures are still
    // available per row/total as actualVendorCostPaid.
    const financeMatch: FilterQuery<FinanceDocument> = {
      organizationId,
      dealId: { $exists: true, $ne: null },
      paymentStatus: { $ne: 'cancelled' },
      createdAt: { $gte: start, $lt: end },
    };
    if (filters.vendorId?.length) financeMatch.vendorRef = { $in: filters.vendorId };

    const [financeDocs, allFinanceDocsInRange] = await Promise.all([
      this.financeDocumentModel.find(financeMatch).exec(),
      this.financeDocumentModel
        .find({ organizationId, dealId: { $exists: true, $ne: null }, createdAt: { $gte: start, $lt: end } })
        .select({ dealId: 1 })
        .exec(),
    ]);

    const dealIds = [...new Set(financeDocs.map((d) => d.dealId!))];
    // Deal-count-based, not document-count-based — a deal with several
    // vendor invoices (some pending, one paid) must not silently deflate
    // this percentage just because it has more raw documents than deals.
    const totalDealsAnyStatus = new Set(allFinanceDocsInRange.map((d) => d.dealId!)).size;
    if (dealIds.length === 0) {
      return {
        rows: [],
        totals: { customerRevenue: 0, vendorCost: 0, actualVendorCostPaid: 0, grossProfit: 0, grossMarginPct: null, markupPct: null },
        coveragePct: totalDealsAnyStatus > 0 ? 0 : null,
        currencyMismatchCount: 0,
      };
    }

    const [quotes, vendorQuotes, vendors, deals] = await Promise.all([
      this.quoteModel.find({ organizationId, dealId: { $in: dealIds } }).exec(),
      this.vendorQuoteModel.find({ organizationId, dealId: { $in: dealIds } }).exec(),
      this.vendorModel.find({ organizationId }).exec(),
      this.dealModel.find({ organizationId, _id: { $in: dealIds } }).select({ name: 1 }).exec(),
    ]);

    const vendorNameById = new Map(vendors.map((v) => [v._id.toString(), v.name]));
    const dealNameById = new Map(deals.map((d) => [d._id.toString(), d.name]));
    const paymentsByQuote = await this.quotePaymentsService.listPaymentsForQuotes(
      organizationId,
      quotes.map((q) => q._id.toString()),
    );

    const financeByDeal = this.groupBy(financeDocs, (f) => f.dealId!);
    const quotesByDeal = this.groupBy(quotes, (q) => q.dealId!);
    const vendorQuotesByDeal = this.groupBy(vendorQuotes, (vq) => vq.dealId!);

    let currencyMismatchCount = 0;
    const rows: VendorProfitabilityRow[] = dealIds.map((dealId) => {
      const financeForDeal = financeByDeal.get(dealId) ?? [];
      const quotesForDeal = quotesByDeal.get(dealId) ?? [];
      const vendorQuotesForDeal = vendorQuotesByDeal.get(dealId) ?? [];
      const computed = this.computeDealProfitability(financeForDeal, quotesForDeal, vendorQuotesForDeal, vendorNameById, paymentsByQuote);
      if (computed.currencyMismatch) currencyMismatchCount += 1;

      return {
        dealId,
        dealName: dealNameById.get(dealId),
        customerQuoteNo: quotesForDeal[0]?.quoteNumber,
        ...computed,
      };
    });

    // Only rows with both a real linked vendor cost and a real customer
    // quote count toward aggregate totals — a deal with vendor cost but no
    // quote yet is real data (shown in the row list) but can't honestly
    // contribute to a profit total with no revenue side.
    const countable = rows.filter((r) => !r.currencyMismatch && r.quoteCount > 0);
    const totalRevenue = countable.reduce((sum, r) => sum + r.customerRevenue, 0);
    const totalVendorCost = countable.reduce((sum, r) => sum + r.vendorCost, 0);
    const totalActualPaid = countable.reduce((sum, r) => sum + r.actualVendorCostPaid, 0);
    const totalGrossProfit = totalRevenue - totalVendorCost;

    return {
      rows: rows.sort((a, b) => (b.grossProfit ?? 0) - (a.grossProfit ?? 0)),
      totals: {
        customerRevenue: totalRevenue,
        vendorCost: totalVendorCost,
        actualVendorCostPaid: totalActualPaid,
        grossProfit: totalGrossProfit,
        grossMarginPct: totalRevenue > 0 ? Math.round((totalGrossProfit / totalRevenue) * 1000) / 10 : null,
        markupPct: totalVendorCost > 0 ? Math.round((totalGrossProfit / totalVendorCost) * 1000) / 10 : null,
      },
      coveragePct: totalDealsAnyStatus > 0 ? Math.round((dealIds.length / totalDealsAnyStatus) * 1000) / 10 : null,
      currencyMismatchCount,
    };
  }

  // Section 10 — "click a vendor quote to see the complete deal": every
  // linked FinanceDocument and Quote for one specific deal, with no date
  // window (a detail view shows everything about the thing already
  // selected, not a further-filtered slice of it) plus the raw
  // document/quote fields the frontend needs for a PDF link, AI summary, and
  // line items — reusing the exact same computation getOverview() uses, so
  // the two views can never disagree on a shared deal's numbers.
  async getDealDetail(organizationId: string, dealId: string) {
    const deal = await this.dealModel.findOne({ _id: dealId, organizationId }).select({ name: 1 }).exec();
    if (!deal) throw new NotFoundException('Deal not found');

    const [financeDocs, quotes, vendorQuotes, vendors] = await Promise.all([
      this.financeDocumentModel.find({ organizationId, dealId, paymentStatus: { $ne: 'cancelled' } }).sort({ createdAt: -1 }).exec(),
      this.quoteModel.find({ organizationId, dealId }).sort({ createdAt: -1 }).exec(),
      this.vendorQuoteModel.find({ organizationId, dealId }).exec(),
      this.vendorModel.find({ organizationId }).exec(),
    ]);

    const vendorNameById = new Map(vendors.map((v) => [v._id.toString(), v.name]));
    const paymentsByQuote = await this.quotePaymentsService.listPaymentsForQuotes(organizationId, quotes.map((q) => q._id.toString()));
    const computed = this.computeDealProfitability(financeDocs, quotes, vendorQuotes, vendorNameById, paymentsByQuote);

    return {
      dealId,
      dealName: deal.name,
      customerQuoteNo: quotes[0]?.quoteNumber,
      ...computed,
      financeDocuments: financeDocs.map((f) => ({
        id: f._id.toString(),
        originalFilename: f.originalFilename,
        invoiceNumber: f.invoiceNumber,
        vendorName: f.vendorName,
        paymentAmount: f.paymentAmount,
        currency: f.currency,
        paymentStatus: f.paymentStatus,
        dueDate: f.dueDate,
        paymentDate: f.paymentDate,
        aiSummary: f.aiSummary,
        gridFsFileId: f.gridFsFileId,
      })),
      quotes: quotes.map((q) => ({
        id: q._id.toString(),
        quoteNumber: q.quoteNumber,
        customerName: q.clientDetails?.companyName ?? q.quoteName,
        quoteAmount: q.quoteAmount,
        currency: q.currency,
        clientApprovalStatus: q.clientApprovalStatus,
        paidAmount: q.paidAmount,
        items: q.items,
      })),
    };
  }

  // Shared by getOverview() (per deal in range) and getDealDetail() (one
  // deal, no date window) so the two views can never compute a shared deal's
  // numbers differently.
  private computeDealProfitability(
    financeForDeal: FinanceDocumentDocument[],
    quotesForDeal: QuoteDocument[],
    vendorQuotesForDeal: VendorQuoteDocument[],
    vendorNameById: Map<string, string>,
    paymentsByQuote: Map<string, QuotePaymentDocument[]>,
  ): Omit<VendorProfitabilityRow, 'dealId' | 'dealName' | 'customerQuoteNo'> {
    const vendorCost = financeForDeal.reduce((sum, f) => sum + f.paymentAmount, 0);
    const vendorCostCurrency = financeForDeal[0]?.currency ?? 'INR';
    const vendorCurrenciesMatch = financeForDeal.every((f) => f.currency === vendorCostCurrency);

    const paidDocs = financeForDeal.filter((f) => f.paymentStatus === 'paid' || f.paymentStatus === 'partially_paid');
    const actualVendorCostPaid = paidDocs.reduce((sum, f) => sum + f.paymentAmount, 0);
    const vendorPaymentStatus: 'paid' | 'partially_paid' | 'pending' =
      financeForDeal.length > 0 && financeForDeal.every((f) => f.paymentStatus === 'paid')
        ? 'paid'
        : paidDocs.length > 0
          ? 'partially_paid'
          : 'pending';

    const customerRevenue = quotesForDeal.reduce((sum, q) => sum + q.quoteAmount, 0);
    const customerRevenueCurrency = quotesForDeal[0]?.currency ?? vendorCostCurrency;
    const revenueCurrenciesMatch = quotesForDeal.every((q) => q.currency === customerRevenueCurrency);

    const customerPaid = quotesForDeal.reduce((sum, q) => {
      const payments = paymentsByQuote.get(q._id.toString()) ?? [];
      return sum + payments.filter((p) => !p.voided).reduce((s, p) => s + p.amount, 0);
    }, 0);
    const customerPaymentStatus: 'paid' | 'partially_paid' | 'pending' =
      customerRevenue > 0 && customerPaid >= customerRevenue ? 'paid' : customerPaid > 0 ? 'partially_paid' : 'pending';

    const currencyMismatch = !vendorCurrenciesMatch || !revenueCurrenciesMatch || (quotesForDeal.length > 0 && vendorCostCurrency !== customerRevenueCurrency);

    const grossProfit = currencyMismatch ? null : customerRevenue - vendorCost;
    const grossMarginPct = grossProfit !== null && customerRevenue > 0 ? Math.round((grossProfit / customerRevenue) * 1000) / 10 : null;
    const markupPct = grossProfit !== null && vendorCost > 0 ? Math.round((grossProfit / vendorCost) * 1000) / 10 : null;

    const vendorNames = [...new Set(vendorQuotesForDeal.map((vq) => vendorNameById.get(vq.vendorId) ?? 'Unknown vendor'))];
    if (vendorNames.length === 0 && financeForDeal.some((f) => f.vendorRef)) {
      for (const f of financeForDeal) {
        if (f.vendorRef && vendorNameById.has(f.vendorRef)) vendorNames.push(vendorNameById.get(f.vendorRef)!);
      }
    }

    const vendorQuoteNumbers = [...new Set(financeForDeal.map((f) => f.invoiceNumber).filter((v): v is string => !!v))];

    return {
      vendorNames: [...new Set(vendorNames)],
      vendorCost,
      actualVendorCostPaid,
      vendorCostCurrency,
      customerRevenue,
      customerRevenueCurrency,
      customerPaid,
      grossProfit,
      grossMarginPct,
      markupPct,
      currencyMismatch,
      vendorQuoteCount: vendorQuotesForDeal.length,
      quoteCount: quotesForDeal.length,
      vendorPaymentStatus,
      customerPaymentStatus,
      vendorQuoteNumbers,
    };
  }

  private groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
    const map = new Map<string, T[]>();
    for (const item of items) {
      const key = keyFn(item);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return map;
  }
}
