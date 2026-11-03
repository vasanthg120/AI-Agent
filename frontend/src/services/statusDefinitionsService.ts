import { axiosClient } from '@/api/axiosClient';

// Phase 2a of the Hoops-parity plan (backend/src/status-definitions) — the
// display metadata (label/color/order) for an existing, already-recognized
// status value. `field` is one of a fixed allow-list the backend enforces
// ('deal.dealStatus' | 'quote.clientApprovalStatus' | 'quote.quoteStatus');
// `key` always matches a value the rest of the app already understands —
// this never invents a new status.
export interface StatusDefinition {
  _id: string;
  organizationId: string;
  field: string;
  key: string;
  label: string;
  color?: string;
  order: number;
  active: boolean;
}

export interface UpdateStatusDefinitionPayload {
  label?: string;
  color?: string;
}

export const statusDefinitionsService = {
  async list(field: string): Promise<StatusDefinition[]> {
    const { data } = await axiosClient.get<StatusDefinition[]>('/status-definitions', { params: { field } });
    return data;
  },

  async relabel(field: string, key: string, payload: UpdateStatusDefinitionPayload): Promise<StatusDefinition> {
    const { data } = await axiosClient.patch<StatusDefinition>(
      `/status-definitions/${field}/${key}`,
      payload,
    );
    return data;
  },
};
