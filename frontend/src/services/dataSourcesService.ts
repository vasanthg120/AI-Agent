import { axiosClient } from '@/api/axiosClient';
import type { WebhookInfo } from './zapierService';

// CRM data sources (see backend/src/data-sources): every connected CRM — plus
// records created in HaiVE itself — is a separate source with its own field
// mappings, capabilities and sync state. The app shows one source at a time
// (the organization's default unless someone picks another), or a Unified
// View when explicitly chosen; every metric says where it comes from, or why
// the selected CRM can't provide it.

export type CrmModule =
  'deals' | 'quotes' | 'contacts' | 'accounts' | 'pipelines' | 'owners' | 'notes' | 'tags' | 'products';
export type MirroredModule = 'deals' | 'quotes' | 'contacts' | 'accounts';
export type SelectionMode = 'default' | 'source' | 'unified';

export interface Terminology {
  deal: string;
  quote: string;
  contact: string;
  account: string;
}

export interface SyncState {
  enabled: boolean;
  intervalMinutes: number;
  lastSyncAt?: string;
  lastStatus: 'never' | 'running' | 'ok' | 'error';
  lastError?: string;
  lastCounts?: Record<string, number>;
  supported: boolean;
}

export interface DataSourceView {
  id: string;
  key: string;
  provider: string;
  providerLabel: string;
  label: string;
  status: 'active' | 'disconnected';
  isDefault: boolean;
  native: boolean;
  modules: CrmModule[];
  terminology: Terminology;
  sync: SyncState;
  recordCounts: Record<MirroredModule, number>;
  supportedMetrics: string[];
}

export interface EmailSourceView {
  provider: 'outlook' | 'gmail';
  label: string;
  mailboxes: number;
  needsReconnect: number;
}

export interface MetricAvailability {
  id: string;
  label: string;
  kind: 'crm' | 'email';
  status: 'supported' | 'not_supported' | 'no_source';
  sources: string[];
  reason?: string;
}

export interface DataSourcesOverview {
  selection: { mode: SelectionMode; sourceIds: string[] };
  sources: DataSourceView[];
  emailSources: EmailSourceView[];
  metrics: MetricAvailability[];
  hiddenMetrics: string[];
  unifiedAvailable: boolean;
}

export interface StageMapping {
  value: string;
  label: string;
  category: 'open' | 'won' | 'lost';
}

export type FieldMappings = Partial<Record<MirroredModule, Record<string, string>>>;

export interface DataSourceAdminView extends DataSourceView {
  integrationProvider?: string;
  connectionId?: string;
  fieldMappings: FieldMappings;
  statusMapping: { won: string[]; lost: string[] };
  stageMappings: StageMapping[];
  availableFields: Partial<Record<MirroredModule, string[]>>;
  defaults: { fieldMappings: FieldMappings; statusMapping: { won: string[]; lost: string[] } };
  // Sources fed by a Zap (provider "zapier"): where they receive records.
  webhook?: WebhookInfo;
}

export interface CanonicalField {
  key: string;
  label: string;
  hint: string;
}

export interface DataSourceCatalog {
  providers: { id: string; label: string; description: string; modules: CrmModule[]; syncSupported: boolean }[];
  modules: CrmModule[];
  canonicalFields: Record<MirroredModule, CanonicalField[]>;
  metrics: { id: string; label: string; kind: 'crm' | 'email' }[];
}

export interface UpdateDataSourcePayload {
  label?: string;
  isDefault?: boolean;
  modules?: CrmModule[];
  terminology?: Partial<Terminology>;
  fieldMappings?: FieldMappings;
  statusMapping?: { won: string[]; lost: string[] };
  stageMappings?: StageMapping[];
  syncEnabled?: boolean;
  syncIntervalMinutes?: number;
}

export const dataSourcesService = {
  async getOverview(): Promise<DataSourcesOverview> {
    const { data } = await axiosClient.get<DataSourcesOverview>('/data-sources/overview');
    return data;
  },

  async setHiddenMetrics(hiddenMetrics: string[]): Promise<string[]> {
    const { data } = await axiosClient.put<{ hiddenMetrics: string[] }>('/data-sources/preferences', { hiddenMetrics });
    return data.hiddenMetrics;
  },

  async listForAdmin(): Promise<DataSourceAdminView[]> {
    const { data } = await axiosClient.get<DataSourceAdminView[]>('/data-sources');
    return data;
  },

  async getCatalog(): Promise<DataSourceCatalog> {
    const { data } = await axiosClient.get<DataSourceCatalog>('/data-sources/catalog');
    return data;
  },

  async update(id: string, payload: UpdateDataSourcePayload): Promise<DataSourceAdminView> {
    const { data } = await axiosClient.patch<DataSourceAdminView>(`/data-sources/${id}`, payload);
    return data;
  },

  async syncNow(id: string): Promise<{ status: string; error?: string } & Record<string, unknown>> {
    const { data } = await axiosClient.post(`/data-sources/${id}/sync`);
    return data;
  },

  async reconcile(): Promise<DataSourceAdminView[]> {
    const { data } = await axiosClient.post<DataSourceAdminView[]>('/data-sources/reconcile');
    return data;
  },
};

export const MODULE_LABEL: Record<CrmModule, string> = {
  deals: 'Deals',
  quotes: 'Quotes',
  contacts: 'Contacts',
  accounts: 'Companies / accounts',
  pipelines: 'Pipelines & stages',
  owners: 'Owners (sales reps)',
  notes: 'Notes',
  tags: 'Tags',
  products: 'Products',
};

/** "Opportunity" -> "Opportunities", "Deal" -> "Deals", "Sales Case" -> "Sales Cases". */
export function pluralize(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}
