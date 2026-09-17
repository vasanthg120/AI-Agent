import { axiosClient } from '@/api/axiosClient';

export interface Invoice {
  _id: string;
  organizationId: string;
  storeId?: string;
  dealId?: string;
  quoteId?: string;
  invoiceNumber: string;
  clientDetails?: { companyName?: string; contactName?: string; email?: string; phone?: string };
  salespersonId?: string;
  invoiceDate: string;
  originalValue: number;
  previousValue?: number;
  currentValue: number;
  currency: string;
  // What the Gross Margin report (reporting/gross-margin-report.service.ts)
  // is computed from — manually entered here, never fabricated. Undefined
  // (not 0) means "not entered yet," excluded from every margin total
  // rather than counted as a real zero-cost invoice.
  costAmount?: number;
  invoiceStatus: 'draft' | 'invoiced' | 'paid';
  voidStatus: boolean;
  voidDate?: string;
  voidReason?: string;
  source: 'auto_from_quote' | 'manual';
  createdAt: string;
}

export interface ListInvoicesFilters {
  dateFrom?: string;
  dateTo?: string;
  invoiceStatus?: string[];
}

export interface ListInvoicesResult {
  items: Invoice[];
  total: number;
  page: number;
  pageSize: number;
}

// Royalty Invoice is the single source of truth Quote.paidAmount is derived
// from (see backend InvoicesService.syncQuotePaidAmount) — this is the one
// place a human actually confirms cash came in, since neither the external
// CRM nor Deal/Quote carry a real "amount received" signal on their own.
export const invoicesService = {
  async listFiltered(filters: ListInvoicesFilters, page: number, pageSize: number): Promise<ListInvoicesResult> {
    const params: Record<string, unknown> = { page, pageSize };
    if (filters.dateFrom) params.dateFrom = filters.dateFrom;
    if (filters.dateTo) params.dateTo = filters.dateTo;
    if (filters.invoiceStatus?.length) params.invoiceStatus = filters.invoiceStatus.join(',');
    const { data } = await axiosClient.get<ListInvoicesResult>('/royalty/invoices/query', { params });
    return data;
  },

  async setStatus(id: string, invoiceStatus: 'draft' | 'invoiced' | 'paid'): Promise<Invoice> {
    const { data } = await axiosClient.patch<Invoice>(`/royalty/invoices/${id}`, { invoiceStatus });
    return data;
  },

  // The Gross Margin report has always had a field for this on the backend
  // (UpdateInvoiceDto.costAmount) but no way to actually enter it anywhere
  // in the app — this is that missing entry point.
  async setCost(id: string, costAmount: number): Promise<Invoice> {
    const { data } = await axiosClient.patch<Invoice>(`/royalty/invoices/${id}`, { costAmount });
    return data;
  },
};
