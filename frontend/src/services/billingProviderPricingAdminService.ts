import { adminAxiosClient } from '@/api/adminAxiosClient';

export interface ProviderPricingRow {
  _id: string;
  provider: string;
  model: string;
  inputCostPerMTokUsd: number;
  outputCostPerMTokUsd: number;
  marginOverridePct?: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface CreateProviderPricingPayload {
  provider: string;
  model?: string;
  inputCostPerMTokUsd: number;
  outputCostPerMTokUsd: number;
  marginOverridePct?: number;
}

// GET/POST over backend/src/billing/billing-admin-provider-pricing.controller.ts
// — "create" always makes a NEW versioned row (never edits one in place), so
// a rate/margin change never rewrites how a past, already-settled
// transaction was priced. See that schema's own effectiveFrom/effectiveTo
// comment.
export const billingProviderPricingAdminService = {
  async list(): Promise<ProviderPricingRow[]> {
    const { data } = await adminAxiosClient.get<ProviderPricingRow[]>('/billing/admin/provider-pricing');
    return data;
  },

  async create(payload: CreateProviderPricingPayload): Promise<ProviderPricingRow> {
    const { data } = await adminAxiosClient.post<ProviderPricingRow>('/billing/admin/provider-pricing', payload);
    return data;
  },
};
