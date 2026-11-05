import { axiosClient } from '@/api/axiosClient';

export type ProductKind = 'product' | 'prebuilt';

export interface Product {
  _id: string;
  organizationId: string;
  name: string;
  sku?: string;
  description?: string;
  unitPrice: number;
  currency: string;
  isActive: boolean;
  vendorId?: string;
  imageFileId?: string;
  sizes: string[];
  colors: string[];
  kind: ProductKind;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductFilters {
  search?: string;
  isActive?: boolean;
  vendorId?: string;
  kind?: ProductKind;
}

export interface CreateProductPayload {
  name: string;
  sku?: string;
  description?: string;
  unitPrice: number;
  currency?: string;
  isActive?: boolean;
  vendorId?: string;
  sizes?: string[];
  colors?: string[];
  kind?: ProductKind;
}

export type UpdateProductPayload = Partial<CreateProductPayload>;

export interface ListProductsResult {
  items: Product[];
  total: number;
  page: number;
  pageSize: number;
}

// Native product/service catalog Quote line items reference — mirrors
// dealsService.ts's exact shape/conventions.
export const productsService = {
  async listFiltered(filters: ProductFilters, page = 1, pageSize = 25): Promise<ListProductsResult> {
    const { data } = await axiosClient.get<ListProductsResult>('/crm/products/query', {
      params: { ...filters, page, pageSize },
    });
    return data;
  },

  async getOne(id: string): Promise<Product> {
    const { data } = await axiosClient.get<Product>(`/crm/products/${id}`);
    return data;
  },

  async create(payload: CreateProductPayload): Promise<Product> {
    const { data } = await axiosClient.post<Product>('/crm/products', payload);
    return data;
  },

  async update(id: string, payload: UpdateProductPayload): Promise<Product> {
    const { data } = await axiosClient.patch<Product>(`/crm/products/${id}`, payload);
    return data;
  },

  async activate(id: string): Promise<Product> {
    const { data } = await axiosClient.post<Product>(`/crm/products/${id}/activate`);
    return data;
  },

  async deactivate(id: string): Promise<Product> {
    const { data } = await axiosClient.post<Product>(`/crm/products/${id}/deactivate`);
    return data;
  },

  async uploadImage(id: string, file: File): Promise<Product> {
    const form = new FormData();
    form.append('file', file);
    const { data } = await axiosClient.post<Product>(`/crm/products/${id}/image`, form);
    return data;
  },

  // JwtAuthGuard-protected — a plain <img src> can't carry the Bearer
  // token, so callers fetch this as a blob and build an object URL (same
  // pattern as CloudPreviewModal.tsx's inline image preview).
  async getImageBlob(id: string): Promise<Blob> {
    const { data } = await axiosClient.get<Blob>(`/crm/products/${id}/image`, { responseType: 'blob' });
    return data;
  },
};
