import { axiosClient } from '@/api/axiosClient';
import { ROUTES } from '@/constants/routes';

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
  // The synced CRM's own free-text user label — distinct from ownerUserId
  // (a real HaiVE userId, reassignable). SalesBoard's "User" column reads
  // this; "Sales Rep" reads ownerUserId resolved to a name.
  quoteOwnerLabel?: string;
  dueDate?: string;
  paidAmount: number;
  // Native quote line items (empty for synced/legacy quotes, which keep
  // using the flat quoteAmount exactly as before).
  items: QuoteLineItem[];
  subtotal: number;
  discountAmount: number;
  taxAmount: number;

  // --- Hoops-parity SalesBoard additions (see backend quote.schema.ts) ---
  salesStatus?: string;
  classification?: string;
  paymentInvoiceStatus?: string;
  orderStatus?: string;
  paymentStatus?: string;
  deliveryStatus?: string;
  artworkStatus?: string;
  productionReadyStatus?: string;
  completedStatus?: string;
  productionHouseVendorId?: string;
  vendorIds: string[];
  decorationId?: string;
  customerType?: string;
  deliveryDate?: string;
  referenceFileId?: string;
  referenceFileName?: string;
  referenceFileMimeType?: string;
  createdByUserId?: string;
  archived: boolean;
  guestViewToken?: string;
  viewedAt?: string;
  viewCount: number;
}

export const QUOTE_CUSTOMER_TYPES = ['new', 'bau'] as const;
export type QuoteCustomerType = (typeof QUOTE_CUSTOMER_TYPES)[number];

// Field keys status-definitions.service.ts seeds for categories A-I — the
// exact strings every StatusDropdown/StatusBadge instance below passes as
// `field`.
export const QUOTE_STATUS_FIELDS = [
  'salesStatus',
  'classification',
  'paymentInvoiceStatus',
  'orderStatus',
  'paymentStatus',
  'deliveryStatus',
  'artworkStatus',
  'productionReadyStatus',
  'completedStatus',
] as const;
export type QuoteStatusField = (typeof QUOTE_STATUS_FIELDS)[number];

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
  salesStatus?: string;
  classification?: string;
  paymentInvoiceStatus?: string;
  orderStatus?: string;
  paymentStatus?: string;
  deliveryStatus?: string;
  artworkStatus?: string;
  productionReadyStatus?: string;
  completedStatus?: string;
  productionHouseVendorId?: string;
  vendorIds?: string[];
  decorationId?: string;
  customerType?: string;
  deliveryDate?: string;
  ownerUserId?: string;
  archived?: boolean;
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
  // 'draft' | 'published' | 'sent' — mirrors backend quotes.service.ts's
  // ListQuotesFilter exactly; added for the SalesBoard's status tabs.
  quoteStatus?: string;
  search?: string;
  salesStatus?: string;
  classification?: string;
  paymentInvoiceStatus?: string;
  orderStatus?: string;
  paymentStatus?: string;
  deliveryStatus?: string;
  artworkStatus?: string;
  productionReadyStatus?: string;
  completedStatus?: string;
  productionHouseVendorId?: string;
  vendorId?: string;
  decorationId?: string;
  customerType?: string;
  ownerUserId?: string;
  createdByUserId?: string;
  sort?: string;
  direction?: 'asc' | 'desc';
  archived?: 'only' | 'include';
  deadlineFrom?: string;
  deadlineTo?: string;
  deliveryDateFrom?: string;
  deliveryDateTo?: string;
  paymentDeadlineFrom?: string;
  paymentDeadlineTo?: string;
  totalMin?: number;
  totalMax?: number;
  hasReference?: 'only' | 'missing';
  viewed?: 'only' | 'unviewed';
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

  // --- Hoops-parity SalesBoard record actions ---

  async duplicate(id: string): Promise<Quote> {
    const { data } = await axiosClient.post<Quote>(`/crm/quotes/${id}/duplicate`);
    return data;
  },

  async setArchived(id: string, archived: boolean): Promise<Quote> {
    const { data } = await axiosClient.post<Quote>(`/crm/quotes/${id}/archive`, { archived });
    return data;
  },

  async remove(id: string): Promise<void> {
    await axiosClient.delete(`/crm/quotes/${id}`);
  },

  async send(id: string): Promise<{ sent: boolean; to: string }> {
    const { data } = await axiosClient.post<{ sent: boolean; to: string }>(`/crm/quotes/${id}/send`);
    return data;
  },

  async getGuestLink(id: string): Promise<string> {
    const { data } = await axiosClient.post<{ token: string }>(`/crm/quotes/${id}/guest-link`);
    const path = ROUTES.quoteGuestView.replace(':token', data.token);
    return `${window.location.origin}${path}`;
  },

  async setReferenceFile(id: string, file: File): Promise<Quote> {
    const form = new FormData();
    form.append('file', file);
    const { data } = await axiosClient.post<Quote>(`/crm/quotes/${id}/reference`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data;
  },

  referenceFileUrl(id: string): string {
    return `/crm/quotes/${id}/reference`;
  },

  async downloadBlob(url: string, suggestedFilename: string): Promise<void> {
    const { data } = await axiosClient.get(url, { responseType: 'blob' });
    const href = URL.createObjectURL(data as Blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = suggestedFilename;
    link.click();
    URL.revokeObjectURL(href);
  },

  downloadPdf(id: string, quoteNumber?: string): Promise<void> {
    return this.downloadBlob(`/crm/quotes/${id}/pdf`, `${quoteNumber ?? id}.pdf`);
  },

  downloadInvoicePdf(id: string, quoteNumber?: string): Promise<void> {
    return this.downloadBlob(`/crm/quotes/${id}/invoice-pdf`, `${quoteNumber ?? id}-payments.pdf`);
  },
};
