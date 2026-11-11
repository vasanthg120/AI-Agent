import { axiosClient } from '@/api/axiosClient';

export interface Vendor {
  _id: string;
  organizationId: string;
  name: string;
  contactName?: string;
  email?: string;
  phone?: string;
  category?: string;
  address?: string;
  taxId?: string;
  bankDetails?: { bankName?: string; accountNumber?: string; ifscOrSwift?: string; accountHolderName?: string };
  status: 'active' | 'inactive';
  notes?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateVendorPayload {
  name: string;
  contactName?: string;
  email?: string;
  phone?: string;
  category?: string;
  address?: string;
  taxId?: string;
  notes?: string;
}

export type UpdateVendorPayload = Partial<CreateVendorPayload> & { status?: 'active' | 'inactive' };

export interface VendorQuote {
  _id: string;
  organizationId: string;
  vendorId: string;
  dealId?: string;
  quoteId?: string;
  vendorReferenceNumber?: string;
  description?: string;
  quotedAmount: number;
  currency: string;
  quoteDate: string;
  validUntil?: string;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  acceptedAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateVendorQuotePayload {
  vendorId: string;
  dealId?: string;
  quoteId?: string;
  vendorReferenceNumber?: string;
  description?: string;
  quotedAmount: number;
  currency?: string;
  quoteDate: string;
  validUntil?: string;
  status?: 'pending' | 'accepted' | 'rejected' | 'expired';
}

export interface VendorOption {
  _id: string;
  name: string;
}

export const vendorsService = {
  async list(): Promise<Vendor[]> {
    const { data } = await axiosClient.get<Vendor[]>('/vendors');
    return data;
  },

  // Name-only projection, reachable by manager/consultant (unlike the rest
  // of this service, gated owner/admin-only server-side) — backs the Vendor
  // picker in the Catalog forms without exposing bank/tax/contact data.
  async listPicker(): Promise<VendorOption[]> {
    const { data } = await axiosClient.get<VendorOption[]>('/vendors/picker');
    return data;
  },

  async create(payload: CreateVendorPayload): Promise<Vendor> {
    const { data } = await axiosClient.post<Vendor>('/vendors', payload);
    return data;
  },

  async update(id: string, payload: UpdateVendorPayload): Promise<Vendor> {
    const { data } = await axiosClient.patch<Vendor>(`/vendors/${id}`, payload);
    return data;
  },

  async listQuotes(params?: { vendorId?: string; dealId?: string; quoteId?: string }): Promise<VendorQuote[]> {
    const { data } = await axiosClient.get<VendorQuote[]>('/vendor-quotes', { params });
    return data;
  },

  async createQuote(payload: CreateVendorQuotePayload): Promise<VendorQuote> {
    const { data } = await axiosClient.post<VendorQuote>('/vendor-quotes', payload);
    return data;
  },

  async updateQuote(id: string, payload: Partial<CreateVendorQuotePayload>): Promise<VendorQuote> {
    const { data } = await axiosClient.patch<VendorQuote>(`/vendor-quotes/${id}`, payload);
    return data;
  },
};
