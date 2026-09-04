import { axiosClient } from '@/api/axiosClient';

export interface QuoteClientDetails {
  companyName?: string;
  contactName?: string;
  email?: string;
  phone?: string;
}

export interface QuoteLineItem {
  productId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  taxRate: number;
  lineSubtotal: number;
  lineTotal: number;
}

// Accepted on create/update — lineSubtotal/lineTotal are never sent, the
// backend always computes them (see quote-pricing.util.ts).
export interface QuoteLineItemInput {
  productId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  discount?: number;
  taxRate?: number;
}

export const NATIVE_QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired', 'cancelled'] as const;

export interface Quote {
  _id: string;
  organizationId: string;
  dealId?: string;
  quoteName?: string;
  quoteNumber?: string;
  quoteStatus: string;
  clientApprovalStatus: string;
  quoteAmount: number;
  currency: string;
  expirationDate?: string;
  externalId?: string;
  clientDetails?: QuoteClientDetails;
  createdAt: string;
  // Business Intelligence additions (see backend quote.schema.ts) — unset on
  // records created before these fields existed.
  sourceEmailIntelligenceItemId?: string;
  ownerUserId?: string;
  dueDate?: string;
  paidAmount: number;
  // Native quote line items (empty for synced/legacy quotes, which keep
  // using the flat quoteAmount exactly as before).
  items: QuoteLineItem[];
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
}

export interface CreateQuotePayload {
  clientDetails?: QuoteClientDetails;
  quoteName?: string;
  dealId?: string;
  expirationDate?: string;
  dueDate?: string;
  currency?: string;
  requestNotes?: string;
  items: QuoteLineItemInput[];
}

export interface UpdateQuotePayload {
  quoteName?: string;
  quoteStatus?: string;
  clientApprovalStatus?: string;
  quoteAmount?: number;
  currency?: string;
  expirationDate?: string;
  dueDate?: string;
  requestNotes?: string;
  dealId?: string;
  clientDetails?: QuoteClientDetails;
  items?: QuoteLineItemInput[];
}

export interface QuotePayment {
  _id: string;
  organizationId: string;
  quoteId: string;
  amount: number;
  paymentDate: string;
  paymentMethod?: string;
  reference?: string;
  recordedBy: string;
  voided: boolean;
  voidedAt?: string;
  voidedBy?: string;
  voidReason?: string;
}

export interface ListQuotesFilters {
  dateFrom?: string;
  dateTo?: string;
  clientApprovalStatus?: string;
}

export interface ListQuotesResult {
  items: Quote[];
  total: number;
  page: number;
  pageSize: number;
}

// Phase 19 — the Unified Analytics Dashboard's quote drill-down. Mirrors
// dealsService.listFiltered's exact shape/scoping (server-side role
// branching, no client-supplied scope beyond the filters themselves).
export const quotesService = {
  async listFiltered(filters: ListQuotesFilters, page = 1, pageSize = 25): Promise<ListQuotesResult> {
    const { data } = await axiosClient.get<ListQuotesResult>('/crm/quotes/query', {
      params: { ...filters, page, pageSize },
    });
    return data;
  },

  async getOne(id: string): Promise<Quote> {
    const { data } = await axiosClient.get<Quote>(`/crm/quotes/${id}`);
    return data;
  },

  // Native quote creation — the backend always recomputes subtotal/
  // discountAmount/taxAmount/quoteAmount from `items`; nothing sent here is
  // trusted as the final total.
  async create(payload: CreateQuotePayload): Promise<Quote> {
    const { data } = await axiosClient.post<Quote>('/crm/quotes', payload);
    return data;
  },

  // Section 7 (Business Intelligence: Customer Quote & Payment Tracking) —
  // rejects quoteAmount/clientApprovalStatus/quoteStatus/items edits (400)
  // on any quote synced from the external CRM (externalId set) — see the
  // backend's own SYNC_OWNED_FIELDS guard.
  async update(id: string, payload: UpdateQuotePayload): Promise<Quote> {
    const { data } = await axiosClient.patch<Quote>(`/crm/quotes/${id}`, payload);
    return data;
  },

  // Already fully implemented on the backend (record/void payment routes
  // exist too) — this read-only method is the first frontend caller of any
  // kind. Recording/voiding a payment is intentionally not wired into the
  // UI in this pass (see the Quotes in Pipeline V1 plan's scope note).
  async listPayments(quoteId: string): Promise<QuotePayment[]> {
    const { data } = await axiosClient.get<QuotePayment[]>(`/crm/quotes/${quoteId}/payments`);
    return data;
  },
};
