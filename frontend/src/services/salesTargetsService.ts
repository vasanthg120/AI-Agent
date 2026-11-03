import { axiosClient } from '@/api/axiosClient';

export type TargetScope = 'org' | 'store' | 'user';

export interface SalesTarget {
  _id: string;
  organizationId: string;
  scope: TargetScope;
  storeId?: string;
  userId?: string;
  period: string;
  targetAmount: number;
  currency: string;
}

export interface UpsertSalesTargetPayload {
  scope: TargetScope;
  storeId?: string;
  userId?: string;
  period: string;
  targetAmount: number;
  currency?: string;
}

export const salesTargetsService = {
  // currency: only the targets in it (each CRM's targets are in its own currency).
  async list(period: string, currency?: string): Promise<SalesTarget[]> {
    const { data } = await axiosClient.get<SalesTarget[]>('/sales-targets', { params: { period, ...(currency ? { currency } : {}) } });
    return data;
  },

  async upsert(payload: UpsertSalesTargetPayload): Promise<SalesTarget> {
    const { data } = await axiosClient.post<SalesTarget>('/sales-targets', payload);
    return data;
  },
};
