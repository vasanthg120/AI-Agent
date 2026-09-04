import { axiosClient } from '@/api/axiosClient';

export interface Product {
  _id: string;
  organizationId: string;
  name: string;
  sku?: string;
  description?: string;
  unitPrice: number;
  currency: string;
  isActive: boolean;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductFilters {
  search?: string;
  isActive?: boolean;
}

export interface CreateProductPayload {
  name: string;
  sku?: string;
  description?: string;
  unitPrice: number;
  currency?: string;
  isActive?: boolean;
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
};
