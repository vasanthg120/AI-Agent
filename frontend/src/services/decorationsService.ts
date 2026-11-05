import { axiosClient } from '@/api/axiosClient';

export interface PriceBreak {
  quantity: number;
  price: number;
}

export interface Decoration {
  _id: string;
  organizationId: string;
  name: string;
  vendorId?: string;
  category: string;
  setupCost: number;
  priceBreaks: PriceBreak[];
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DecorationFilters {
  search?: string;
  vendorId?: string;
  category?: string;
  sortBy?: 'name' | 'category';
  sortDir?: 'asc' | 'desc';
}

export interface CreateDecorationPayload {
  name: string;
  vendorId?: string;
  category: string;
  setupCost?: number;
  priceBreaks?: PriceBreak[];
}

export type UpdateDecorationPayload = Partial<CreateDecorationPayload>;

export interface ListDecorationsResult {
  items: Decoration[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ImportRowError {
  row: number;
  message: string;
}

export interface ImportDecorationDraft {
  name: string;
  category: string;
  setupCost: number;
  priceBreaks: PriceBreak[];
  rows: number[];
}

export interface ImportPreviewResult {
  decorations: ImportDecorationDraft[];
  errors: ImportRowError[];
}

export interface ImportCommitResult {
  created: number;
  updated: number;
  errors: ImportRowError[];
}

// Hoops-parity Catalog decorations — mirrors productsService.ts's exact
// shape/conventions, plus the CSV import workflow behind "Import Decoration".
export const decorationsService = {
  async listFiltered(filters: DecorationFilters, page = 1, pageSize = 25): Promise<ListDecorationsResult> {
    const { data } = await axiosClient.get<ListDecorationsResult>('/crm/decorations/query', {
      params: { ...filters, page, pageSize },
    });
    return data;
  },

  async getOne(id: string): Promise<Decoration> {
    const { data } = await axiosClient.get<Decoration>(`/crm/decorations/${id}`);
    return data;
  },

  async create(payload: CreateDecorationPayload): Promise<Decoration> {
    const { data } = await axiosClient.post<Decoration>('/crm/decorations', payload);
    return data;
  },

  async update(id: string, payload: UpdateDecorationPayload): Promise<Decoration> {
    const { data } = await axiosClient.patch<Decoration>(`/crm/decorations/${id}`, payload);
    return data;
  },

  async remove(id: string): Promise<void> {
    await axiosClient.delete(`/crm/decorations/${id}`);
  },

  async downloadTemplate(): Promise<Blob> {
    const { data } = await axiosClient.get<Blob>('/crm/decorations/import-template', { responseType: 'blob' });
    return data;
  },

  async previewImport(file: File): Promise<ImportPreviewResult> {
    const form = new FormData();
    form.append('file', file);
    const { data } = await axiosClient.post<ImportPreviewResult>('/crm/decorations/import/preview', form);
    return data;
  },

  async commitImport(file: File, vendorId: string | undefined): Promise<ImportCommitResult> {
    const form = new FormData();
    form.append('file', file);
    if (vendorId) form.append('vendorId', vendorId);
    const { data } = await axiosClient.post<ImportCommitResult>('/crm/decorations/import/commit', form);
    return data;
  },
};
