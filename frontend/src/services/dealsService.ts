import { axiosClient } from '@/api/axiosClient';

export interface Deal {
  _id: string;
  organizationId: string;
  storeId?: string;
  ownerId?: string;
  name: string;
  contactId?: string;
  accountId?: string;
  pipelineId?: string;
  stageId?: string;
  dealStatus: 'open' | 'won' | 'lost';
  monetaryValue: number;
  expectedClosingDate?: string;
  externalId?: string;
  // The raw external-CRM owner reference this deal actually carries (see
  // backend deal.schema.ts's own comment) — present on the wire for every
  // deal-list endpoint today; previously undeclared here, which is why the
  // Deal Assignment page couldn't tell "CRM has an owner, just not mapped
  // yet" apart from "genuinely no owner" even though the data was already
  // there.
  externalOwnerRef?: string;
  externalOwnerLabel?: string;
  externalOwnerProvider?: string;
  // Phase 9a — manual-entry-only dimension fields (see backend deal.schema.ts).
  // Only ever set on natively created/edited deals; external-CRM-synced
  // deals never carry these.
  leadSource?: string;
  product?: string;
  customerType?: string;
  region?: string;
  // Phase 11 — captured when dealStatus flips to 'lost'. lostReasonSource
  // is server-computed (never sent by the client); 'rep_reported' the
  // moment a real lostReason is saved, reserved 'ai_inferred' for a future
  // inference job.
  lostReason?: string;
  lostReasonSource?: 'rep_reported' | 'ai_inferred';
}

export const LEAD_SOURCES = ['referral', 'website', 'cold_call', 'event', 'partner', 'social_media', 'advertisement', 'other'] as const;
export const CUSTOMER_TYPES = ['individual', 'business', 'government', 'other'] as const;
export const REGIONS = ['north', 'south', 'east', 'west', 'central', 'international', 'other'] as const;

// Shared filter shape — reused by the plain deal list/export (this file) and
// the composite dashboard overview (dealPerformanceService.ts), so the two
// never drift on what a filter param is called.
export interface DealFilters {
  // Free-text substring match against Deal.name only (see backend
  // deal-filter.util.ts) — Deal has no first-class customer/account name
  // field to search at the DB layer.
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  // Which field dateFrom/dateTo range against — defaults server-side to
  // createdAt. Pass 'expectedClosingDate' when reconciling against a figure
  // computed from expectedClosingDate (e.g. the achievement/"Total Revenue"
  // number), so the drill-down list matches what was actually summed.
  dateField?: 'createdAt' | 'expectedClosingDate';
  ownerId?: string[];
  storeId?: string[];
  dealStatus?: ('open' | 'won' | 'lost')[];
  stageId?: string[];
  leadSource?: string[];
  product?: string[];
  customerType?: string[];
  region?: string[];
  valueMin?: number;
  valueMax?: number;
}

export interface CreateDealPayload {
  name: string;
  storeId?: string;
  ownerId?: string;
  contactId?: string;
  accountId?: string;
  pipelineId?: string;
  stageId?: string;
  dealStatus?: 'open' | 'won' | 'lost';
  monetaryValue?: number;
  expectedClosingDate?: string;
  leadSource?: string;
  product?: string;
  customerType?: string;
  region?: string;
  lostReason?: string;
}

export type UpdateDealPayload = Partial<CreateDealPayload>;

export interface ListDealsResult {
  items: Deal[];
  total: number;
  page: number;
  pageSize: number;
}

// Provider-agnostic external CRM owner mapping — one row per distinct raw
// owner id seen across this org's synced deals (see backend deal.schema.ts's
// comment on externalOwnerRef). `mapping` is null until an admin links it to
// at least one HaiVE user.
export interface ExternalOwnerRow {
  provider: string;
  externalOwnerRef: string;
  externalOwnerLabel?: string;
  dealCount: number;
  mapping: {
    id: string;
    // Set only when linkedUserIds has exactly one entry — the one user
    // whose deals get auto-assigned (now and on future syncs). Undefined
    // when more than one user is linked — linking is an association, not
    // automatic ownership, so with 2+ users there is no deal-specific
    // signal saying which one a given deal belongs to; an admin resolves
    // each one explicitly via manual/bulk assignment on the table below.
    ownerId?: string;
    ownerName?: string;
    linkedUserIds: string[];
    linkedUsers: { id: string; name?: string }[];
  } | null;
  // Best-effort employee match on the CRM's raw label — a suggestion only,
  // never applied until the admin explicitly confirms it (see
  // DealAssignmentSettings.tsx). Absent when no single employee matches.
  suggestedOwnerId?: string;
  suggestedOwnerName?: string;
}

// Settings → Deal Assignment's own per-deal row — a Deal plus everything
// needed to render ownership accurately without re-deriving any of it
// client-side (see backend deal-owner-mapping.service.ts's
// listDealsForAssignment, the single source of this shape).
export interface AssignmentDealRow {
  _id: string;
  name: string;
  dealStatus: 'open' | 'won' | 'lost';
  monetaryValue: number;
  expectedClosingDate?: string;
  ownerId?: string;
  ownerName?: string;
  externalOwnerRef?: string;
  externalOwnerLabel?: string;
  externalOwnerProvider?: string;
  // 'assigned' — ownerId is set. 'pending_mapping' — the CRM has a real
  // owner (externalOwnerRef) that just isn't linked to a user yet; this is
  // NOT the same thing as no owner at all, and must never render as
  // "Unassigned". 'unassigned' — neither is set: the only case that should.
  ownershipStatus: 'assigned' | 'pending_mapping' | 'unassigned';
  customerName?: string;
  customerNameSource?: 'account' | 'quote_client_details' | 'deal_name_heuristic';
}

export interface ListAssignmentDealsResult {
  items: AssignmentDealRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface UpsertOwnerMappingPayload {
  provider: string;
  externalOwnerRef: string;
  externalOwnerLabel?: string;
  // Every HaiVE user to link to this external salesperson — a single-
  // element array behaves identically to the previous single-owner shape.
  ownerIds: string[];
}

// Arrays are sent as a single comma-separated query param (matches
// DealFilterQueryDto's @Transform on the backend) — simpler to round-trip
// through a saved preset's JSON blob than repeated `?x=a&x=b` params.
export function toDealFilterParams(filters: DealFilters, extra?: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = { ...extra };
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    params[key] = Array.isArray(value) ? value.join(',') : value;
  }
  return params;
}

export const dealsService = {
  async list(storeId?: string): Promise<Deal[]> {
    const { data } = await axiosClient.get<Deal[]>('/crm/deals', { params: storeId ? { storeId } : {} });
    return data;
  },

  async listFiltered(filters: DealFilters, page: number, pageSize: number, sortBy?: string, sortDir?: 'asc' | 'desc'): Promise<ListDealsResult> {
    const { data } = await axiosClient.get<ListDealsResult>('/crm/deals/query', {
      params: toDealFilterParams(filters, { page, pageSize, sortBy, sortDir }),
    });
    return data;
  },

  async getOne(id: string): Promise<Deal> {
    const { data } = await axiosClient.get<Deal>(`/crm/deals/${id}`);
    return data;
  },

  async create(payload: CreateDealPayload): Promise<Deal> {
    const { data } = await axiosClient.post<Deal>('/crm/deals', payload);
    return data;
  },

  async update(id: string, payload: UpdateDealPayload): Promise<Deal> {
    const { data } = await axiosClient.patch<Deal>(`/crm/deals/${id}`, payload);
    return data;
  },

  // Many deals to one person (or to nobody) in a single request.
  async assignMany(dealIds: string[], ownerId: string | null): Promise<{ requested: number; assigned: number }> {
    const { data } = await axiosClient.post<{ requested: number; assigned: number }>('/crm/deals/assign-bulk', { dealIds, ownerId });
    return data;
  },

  async assign(dealId: string, ownerId: string | null): Promise<Deal> {
    const { data } = await axiosClient.patch<Deal>(`/crm/deals/${dealId}/assign`, { ownerId });
    return data;
  },

  async listOwnerMappings(): Promise<ExternalOwnerRow[]> {
    const { data } = await axiosClient.get<ExternalOwnerRow[]>('/crm/deals/owner-mappings');
    return data;
  },

  async listForAssignment(
    filters: DealFilters,
    page: number,
    pageSize: number,
    needsMapping?: boolean,
  ): Promise<ListAssignmentDealsResult> {
    const { data } = await axiosClient.get<ListAssignmentDealsResult>('/crm/deals/assignment', {
      params: toDealFilterParams(filters, { page, pageSize, needsMapping: needsMapping || undefined }),
    });
    return data;
  },

  async upsertOwnerMapping(payload: UpsertOwnerMappingPayload): Promise<ExternalOwnerRow> {
    const { data } = await axiosClient.post<ExternalOwnerRow>('/crm/deals/owner-mappings', payload);
    return data;
  },

  async deleteOwnerMapping(mappingId: string): Promise<void> {
    await axiosClient.delete(`/crm/deals/owner-mappings/${mappingId}`);
  },

  async downloadExport(format: 'csv' | 'xlsx' | 'pdf', filters: DealFilters): Promise<void> {
    const response = await axiosClient.get('/crm/deals/export', {
      params: toDealFilterParams(filters, { format }),
      responseType: 'blob',
    });
    const disposition = response.headers['content-disposition'] as string | undefined;
    const filename = disposition ? /filename="([^"]+)"/.exec(disposition)?.[1] : undefined;
    const url = URL.createObjectURL(response.data as Blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename ?? `deals.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  },
};
