import { axiosClient } from '@/api/axiosClient';

// CRM integrations for the Integrations page (backend/src/crm-integrations).
// The page never knows a CRM's own schema: each integration says what it
// needs to connect (`setup`), how it's doing (`status`/`source`), and the
// mapping endpoints speak only in HaiVE fields ↔ "a field of that CRM".

export interface SetupField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url';
  hint?: string;
  placeholder?: string;
  required: boolean;
  defaultValue?: string;
  advanced?: boolean;
}

export interface WebhookInfo {
  paths: Record<string, string>;
  baseUrl: string;
  keyHint?: string;
  lastReceivedAt?: string;
  received: number;
}

export interface IntegrationError {
  message: string;
  // auth: reconnect · mapping: review the mapping · unreachable/rate_limit: wait and retry · other
  kind: 'auth' | 'mapping' | 'unreachable' | 'rate_limit' | 'other' | string;
  // For whoever has to debug it — shown only behind "View technical details".
  detail?: string;
}

export interface CrmIntegration {
  id: string;
  label: string;
  description: string;
  // pull: HaiVE reads the CRM on a schedule. push: the CRM sends each new record to HaiVE.
  connection: 'pull' | 'push';
  setup: { fields: SetupField[]; provides: string[]; limitations: string[]; steps?: string[] };
  status: 'not_connected' | 'connected' | 'waiting' | 'needs_attention';
  source?: {
    id: string;
    label: string;
    isDefault: boolean;
    health: 'healthy' | 'failing' | 'not_synced' | 'syncing';
    lastSyncAt?: string;
    lastSuccessAt?: string;
    records: Record<string, number>;
    totalRecords: number;
    terminology: Record<string, string>;
    modules: string[];
    error?: IntegrationError;
    webhook?: WebhookInfo;
  };
}

export type Discovery = Record<string, { records: number; fields: number }>;

export interface ConnectResult {
  integration: CrmIntegration;
  discovery?: Discovery;
  // Push CRMs only, and only this once — it is stored as a hash.
  webhookKey?: string;
}

export interface FieldSuggestion {
  key: string;
  label: string;
  hint: string;
  required: boolean;
  source: string | null;
  confidence: number;
  method: 'saved' | 'auto' | 'ai' | 'none';
  needsReview: boolean;
  reason: string;
  example?: string;
}

export interface ModuleSuggestion {
  module: string;
  fields: FieldSuggestion[];
  sourceFields: { path: string; example?: string }[];
  samples: number;
}

export interface MappingSuggestions {
  modules: ModuleSuggestion[];
  reviewCount: number;
  aiUsed: boolean;
}

export type FieldMappings = Record<string, Record<string, string>>;

export interface MappingPreview {
  rows: { module: string; values: Record<string, string | number | null>; problems: string[] }[];
  problems: string[];
  sampleCount: number;
}

export interface SyncRun {
  id: string;
  trigger: 'scheduled' | 'manual' | 'push' | string;
  status: 'ok' | 'error' | string;
  startedAt: string;
  finishedAt: string;
  counts: Record<string, number>;
  processed: number;
  failed: number;
  error?: string;
  errorKind?: string;
  errorDetail?: string;
}

export const crmIntegrationsService = {
  async list(): Promise<CrmIntegration[]> {
    const { data } = await axiosClient.get<CrmIntegration[]>('/crm-integrations');
    return data;
  },

  // Pull CRMs: saved only if their data can really be read. Nothing is synced yet.
  async connect(provider: string, credentials: Record<string, string> = {}): Promise<ConnectResult> {
    const { data } = await axiosClient.post<ConnectResult>(
      `/crm-integrations/${provider}/connect`,
      { credentials },
      { timeout: 180_000 },
    );
    return data;
  },

  async disconnect(provider: string): Promise<CrmIntegration> {
    const { data } = await axiosClient.post<CrmIntegration>(`/crm-integrations/${provider}/disconnect`);
    return data;
  },

  async rotateKey(provider: string): Promise<ConnectResult> {
    const { data } = await axiosClient.post<ConnectResult>(`/crm-integrations/${provider}/rotate-key`);
    return data;
  },

  async syncNow(provider: string): Promise<{ result: { status: string; error?: string }; integration: CrmIntegration }> {
    const { data } = await axiosClient.post(`/crm-integrations/${provider}/sync`, undefined, { timeout: 240_000 });
    return data;
  },

  async history(provider: string): Promise<SyncRun[]> {
    const { data } = await axiosClient.get<SyncRun[]>(`/crm-integrations/${provider}/sync-history`);
    return data;
  },

  async makeDefault(provider: string): Promise<CrmIntegration> {
    const { data } = await axiosClient.post<CrmIntegration>(`/crm-integrations/${provider}/make-default`);
    return data;
  },

  // `ai` also asks the AI about fields a name match left unsure (uses AI credits).
  async suggestMapping(sourceId: string, ai = false): Promise<MappingSuggestions> {
    const { data } = await axiosClient.get<MappingSuggestions>(`/crm-integrations/mapping/${sourceId}`, {
      params: ai ? { ai: true } : undefined,
      timeout: 120_000,
    });
    return data;
  },

  async previewMapping(sourceId: string, fieldMappings: FieldMappings): Promise<MappingPreview> {
    const { data } = await axiosClient.post<MappingPreview>(`/crm-integrations/mapping/${sourceId}/preview`, {
      fieldMappings,
    });
    return data;
  },

  async saveMapping(sourceId: string, fieldMappings: FieldMappings): Promise<void> {
    await axiosClient.put(`/crm-integrations/mapping/${sourceId}`, { fieldMappings });
  },

  async mappingVersions(sourceId: string): Promise<{ version: number; replacedAt: string; fieldCount: number }[]> {
    const { data } = await axiosClient.get(`/crm-integrations/mapping/${sourceId}/versions`);
    return data;
  },

  async restoreMapping(sourceId: string, version: number): Promise<void> {
    await axiosClient.post(`/crm-integrations/mapping/${sourceId}/versions/${version}/restore`);
  },
};

/** The backend's structured connect failure ({message, kind, detail}), when there is one. */
export function integrationErrorOf(error: unknown): IntegrationError | null {
  const data = (error as { response?: { data?: Record<string, unknown> } })?.response?.data;
  if (!data || typeof data.message !== 'string') return null;
  return {
    message: data.message,
    kind: typeof data.kind === 'string' ? data.kind : 'other',
    detail: typeof data.detail === 'string' ? data.detail : undefined,
  };
}
