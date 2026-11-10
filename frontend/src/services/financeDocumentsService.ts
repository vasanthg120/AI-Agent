import { axiosClient } from '@/api/axiosClient';

export const PAYMENT_STATUSES = ['pending', 'overdue', 'partially_paid', 'paid', 'cancelled'] as const;
export const PAYMENT_METHODS = ['bank_transfer', 'credit_card', 'debit_card', 'cheque', 'upi', 'cash', 'other'] as const;

export interface TaxDetails {
  gstAmount?: number;
  vatAmount?: number;
  taxRatePct?: number;
  taxType?: string;
}

export interface BankDetails {
  bankName?: string;
  accountNumber?: string;
  ifscOrSwift?: string;
  accountHolderName?: string;
}

export interface FinanceDocument {
  _id: string;
  organizationId: string;
  uploadedBy: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  gridFsFileId: string;
  documentFormat: 'pdf' | 'image' | 'xlsx' | 'xls' | 'csv' | 'docx';
  extractionStatus: 'processing' | 'completed' | 'failed';
  extractionError?: string;
  reviewStatus: 'needs_review' | 'reviewed';
  reviewedBy?: string;
  reviewedAt?: string;
  vendorName?: string;
  vendorId?: string;
  invoiceNumber?: string;
  poNumber?: string;
  invoiceDate?: string;
  dueDate?: string;
  paymentDate?: string;
  paymentAmount: number;
  currency: string;
  taxAmount: number;
  taxDetails?: TaxDetails;
  deliveryCharges: number;
  isSubscriptionPayment: boolean;
  subscriptionProvider?: string;
  subscriptionCharges: number;
  paymentMethod?: string;
  bankDetails?: BankDetails;
  department?: string;
  costCenter?: string;
  paymentStatus: (typeof PAYMENT_STATUSES)[number];
  expenseCategory?: string;
  otherFinancialInfo: Record<string, unknown>;
  aiSummary?: string;
  missingFields: string[];
  inconsistencyNotes: string[];
  possibleDuplicate: boolean;
  duplicateOfDocumentId?: string;
  dealId?: string;
  quoteId?: string;
  customerQuoteNo?: string;
  createdAt: string;
  updatedAt: string;
}

// Preview shape for the Vendor Quote <-> Customer Quote linking flow — a
// human confirms one of these before anything is saved (see
// FinanceDocumentReviewModal.tsx's CustomerQuoteLink section).
export interface CustomerQuoteMatch {
  quoteId: string;
  quoteNumber?: string;
  dealId?: string;
  customerName?: string;
  quoteAmount: number;
  currency: string;
  clientApprovalStatus: string;
}

// Shared filter shape — reused by the list/export calls and the dashboard
// overview call, so the two never drift on what a filter param is called
// (same convention as dealsService.ts's DealFilters).
export interface FinanceFilters {
  dateFrom?: string;
  dateTo?: string;
  vendorName?: string[];
  department?: string[];
  costCenter?: string[];
  paymentStatus?: string[];
  paymentMethod?: string[];
  expenseCategory?: string[];
  reviewStatus?: 'needs_review' | 'reviewed';
  amountMin?: number;
  amountMax?: number;
  quoteLink?: 'linked' | 'unlinked';
}

// Finance AI quote costing (backend finance/quote-costing.ts): every vendor
// document linked to one customer quote, and what the quote earns once they
// are paid. Amounts as written on the documents, GST included.
export type CostingExclusion = 'processing' | 'extraction_failed' | 'cancelled' | 'currency_mismatch' | 'duplicate';

export interface QuoteCostingLine {
  document: FinanceDocument;
  documentId: string;
  included: boolean;
  excludedReason?: CostingExclusion;
  duplicateOfDocumentId?: string;
}

export interface QuoteCosting {
  quote: CustomerQuoteMatch;
  documents: QuoteCostingLine[];
  totals: {
    quoteAmount: number;
    currency: string;
    vendorCost: number;
    vendorTax: number;
    profit: number;
    marginPct: number | null;
    markupPct: number | null;
    includedCount: number;
    excludedCount: number;
  };
}

export interface UpdateFinanceDocumentPayload {
  vendorName?: string;
  vendorId?: string;
  invoiceNumber?: string;
  poNumber?: string;
  invoiceDate?: string;
  dueDate?: string;
  paymentDate?: string;
  paymentAmount?: number;
  currency?: string;
  taxAmount?: number;
  taxDetails?: TaxDetails;
  deliveryCharges?: number;
  isSubscriptionPayment?: boolean;
  subscriptionProvider?: string;
  subscriptionCharges?: number;
  paymentMethod?: string;
  bankDetails?: BankDetails;
  department?: string;
  costCenter?: string;
  paymentStatus?: (typeof PAYMENT_STATUSES)[number];
  expenseCategory?: string;
}

export interface ListFinanceDocumentsResult {
  items: FinanceDocument[];
  total: number;
  page: number;
  pageSize: number;
}

// Arrays are sent as a single comma-separated query param — matches
// FinanceFilterQueryDto's @Transform on the backend, same convention as
// dealsService.ts's toDealFilterParams.
export function toFinanceFilterParams(filters: FinanceFilters, extra?: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = { ...extra };
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    params[key] = Array.isArray(value) ? value.join(',') : value;
  }
  return params;
}

export const financeDocumentsService = {
  // quoteId: store the document already linked to that customer quote (quote costing).
  async upload(file: File, quoteId?: string): Promise<FinanceDocument> {
    const form = new FormData();
    form.append('file', file);
    if (quoteId) form.append('quoteId', quoteId);
    const { data } = await axiosClient.post<FinanceDocument>('/finance/documents', form);
    return data;
  },

  async listFiltered(filters: FinanceFilters, page: number, pageSize: number): Promise<ListFinanceDocumentsResult> {
    const { data } = await axiosClient.get<ListFinanceDocumentsResult>('/finance/documents/query', {
      params: toFinanceFilterParams(filters, { page, pageSize }),
    });
    return data;
  },

  async getOne(id: string): Promise<FinanceDocument> {
    const { data } = await axiosClient.get<FinanceDocument>(`/finance/documents/${id}`);
    return data;
  },

  async update(id: string, payload: UpdateFinanceDocumentPayload): Promise<FinanceDocument> {
    const { data } = await axiosClient.patch<FinanceDocument>(`/finance/documents/${id}`, payload);
    return data;
  },

  async retryExtraction(id: string): Promise<FinanceDocument> {
    const { data } = await axiosClient.post<FinanceDocument>(`/finance/documents/${id}/retry-extraction`);
    return data;
  },

  // Step 1 of linking — search the org's own CRM quotes by quote number.
  // Empty array is a normal "not found" result, not an error.
  async searchCustomerQuote(quoteNumber: string): Promise<CustomerQuoteMatch[]> {
    const { data } = await axiosClient.get<CustomerQuoteMatch[]>('/finance/documents/quote-lookup', { params: { quoteNumber } });
    return data;
  },

  // Step 2 — persist the link the user confirmed from a searchCustomerQuote result.
  async linkCustomerQuote(id: string, quoteId: string): Promise<{ document: FinanceDocument; linkedQuote: CustomerQuoteMatch }> {
    const { data } = await axiosClient.post<{ document: FinanceDocument; linkedQuote: CustomerQuoteMatch }>(`/finance/documents/${id}/link-quote`, { quoteId });
    return data;
  },

  async unlinkCustomerQuote(id: string): Promise<FinanceDocument> {
    const { data } = await axiosClient.delete<FinanceDocument>(`/finance/documents/${id}/link-quote`);
    return data;
  },

  async getQuoteCosting(quoteId: string): Promise<QuoteCosting> {
    const { data } = await axiosClient.get<QuoteCosting>(`/finance/documents/quote-costing/${quoteId}`);
    return data;
  },

  async remove(id: string): Promise<void> {
    await axiosClient.delete(`/finance/documents/${id}`);
  },

  // GET /finance/documents/:id/file requires the same bearer auth as every
  // other endpoint — a plain <a href> new-tab link can't carry that header,
  // so this fetches as a blob via axios (same as downloadExport) and opens
  // the resulting object URL instead.
  async viewFile(id: string): Promise<void> {
    const response = await axiosClient.get(`/finance/documents/${id}/file`, { responseType: 'blob' });
    const url = URL.createObjectURL(response.data as Blob);
    window.open(url, '_blank');
  },

  async downloadExport(format: 'csv' | 'xlsx' | 'pdf', filters: FinanceFilters): Promise<void> {
    const response = await axiosClient.get('/finance/documents/export', {
      params: toFinanceFilterParams(filters, { format }),
      responseType: 'blob',
    });
    const disposition = response.headers['content-disposition'] as string | undefined;
    const filename = disposition ? /filename="([^"]+)"/.exec(disposition)?.[1] : undefined;
    const url = URL.createObjectURL(response.data as Blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename ?? `finance.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  },
};
