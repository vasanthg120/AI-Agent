import { adminAxiosClient } from '@/api/adminAxiosClient';

// Haive-internal only, same convention as billingAdminService.ts — every
// method here hits an AdminJwtAuthGuard route
// (backend/src/ai-usage/ai-usage-admin.controller.ts) built on top of the
// EXISTING agent_executions collection (python-agent's per-call Anthropic
// token/cost trace), not a new usage-tracking system. Never returns a raw
// API key — see AnthropicUsageSummary.connected/budget, which come from the
// same masked/status shape adminIntegrationsService already uses.

export interface AnthropicUsageSummary {
  provider: 'anthropic';
  connected: boolean;
  budget: { amount: number; period: 'monthly' | 'total'; currency: 'USD' } | null;
  usage: { cost: number; remaining: number | null; percentage: number | null };
  tokens: { input: number; output: number; cacheCreation: number; cacheRead: number; total: number };
  requests: { total: number; successful: number; failed: number };
  sync: { lastSyncedAt: string | null; providerReconciliationAvailable: boolean };
  days: number;
}

export interface AnthropicUsageTimeseriesPoint {
  date: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export interface AnthropicModelBreakdownRow {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface AnthropicOrganizationBreakdownRow {
  organizationId: string;
  organizationName: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface AnthropicUsageRequestRow {
  id: string;
  occurredAt: string;
  organizationId: string | null;
  organizationName: string | null;
  userId: string | null;
  userName: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number | null;
  status: 'success' | 'failed';
}

export interface AnthropicUsageRequestsPage {
  items: AnthropicUsageRequestRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AnthropicUsageRequestFilters {
  days?: number;
  page?: number;
  pageSize?: number;
  model?: string;
  organizationId?: string;
  status?: 'success' | 'failed';
  search?: string;
}

export const aiUsageAdminService = {
  async getSummary(days?: number): Promise<AnthropicUsageSummary> {
    const { data } = await adminAxiosClient.get<AnthropicUsageSummary>('/ai-usage/admin/anthropic/summary', { params: { days } });
    return data;
  },

  async getTimeseries(days?: number): Promise<AnthropicUsageTimeseriesPoint[]> {
    const { data } = await adminAxiosClient.get<AnthropicUsageTimeseriesPoint[]>('/ai-usage/admin/anthropic/timeseries', { params: { days } });
    return data;
  },

  async getModelBreakdown(days?: number): Promise<AnthropicModelBreakdownRow[]> {
    const { data } = await adminAxiosClient.get<AnthropicModelBreakdownRow[]>('/ai-usage/admin/anthropic/models', { params: { days } });
    return data;
  },

  async getOrganizationBreakdown(days?: number): Promise<AnthropicOrganizationBreakdownRow[]> {
    const { data } = await adminAxiosClient.get<AnthropicOrganizationBreakdownRow[]>('/ai-usage/admin/anthropic/organizations', { params: { days } });
    return data;
  },

  async getRequests(filters: AnthropicUsageRequestFilters): Promise<AnthropicUsageRequestsPage> {
    const { data } = await adminAxiosClient.get<AnthropicUsageRequestsPage>('/ai-usage/admin/anthropic/requests', { params: filters });
    return data;
  },

  async refresh(days?: number): Promise<AnthropicUsageSummary> {
    const { data } = await adminAxiosClient.post<AnthropicUsageSummary>('/ai-usage/admin/anthropic/refresh', undefined, { params: { days } });
    return data;
  },

  async setBudget(budgetUsd: number, budgetPeriod?: 'monthly' | 'total'): Promise<{ budgetUsd: number; budgetPeriod: 'monthly' | 'total' }> {
    const { data } = await adminAxiosClient.post('/ai-usage/admin/anthropic/budget', { budgetUsd, budgetPeriod });
    return data;
  },
};
