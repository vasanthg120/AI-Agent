import { axiosClient } from '@/api/axiosClient';
import { env } from '@/config/env';
import type { MirroredModule, Terminology } from './dataSourcesService';

// Zapier in two parts (see backend/src/zapier and data-sources/webhook-sources):
//  - the connector: the organization's Zapier MCP server, whose enabled
//    actions (Hoops "Create Customer", …) the AI can run — the connection
//    token is sent once, stored encrypted server-side and never returned;
//  - webhook sources: a Zap posts each new record (Hoops "New Customer") to a
//    source's own address, and it's kept as its own CRM data source.

export interface ZapierApp {
  app: string;
  read: string[];
  write: string[];
}

export interface ZapierStatus {
  connected: boolean;
  tokenMasked?: string;
  mode?: 'managed' | 'agentic';
  apps?: ZapierApp[];
  toolCount?: number;
  refreshedAt?: string;
  error?: string | null;
}

export interface WebhookInfo {
  paths: Partial<Record<MirroredModule, string>>;
  baseUrl: string;
  keyHint?: string;
  lastReceivedAt?: string;
  received: number;
}

export interface WebhookSourceCreated {
  id: string;
  // Shown once — only its hash is kept.
  key: string;
  webhook: WebhookInfo;
}

export interface CreateWebhookSourcePayload {
  label: string;
  modules?: MirroredModule[];
  terminology?: Partial<Pick<Terminology, 'deal' | 'contact' | 'account'>>;
}

/** The full address Zapier posts to. The backend's configured public address
 * wins; otherwise the one this app talks to (fine for a deployed app, not for
 * localhost — see isLocalAddress). */
export function webhookUrl(webhook: WebhookInfo, module: MirroredModule): string {
  const path = webhook.paths[module] ?? '';
  const base = webhook.baseUrl || new URL(env.apiUrl, window.location.origin).toString().replace(/\/+$/, '');
  return `${base}${path}`;
}

export function isLocalAddress(url: string): boolean {
  try {
    return /^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.)/.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export const zapierService = {
  async getStatus(): Promise<ZapierStatus> {
    const { data } = await axiosClient.get<ZapierStatus>('/zapier/status');
    return data;
  },

  // Checked with Zapier (its actions are listed) before anything is saved.
  async connect(connectionToken: string): Promise<ZapierStatus> {
    const { data } = await axiosClient.post<ZapierStatus>('/zapier/connect', { connectionToken });
    return data;
  },

  async refresh(): Promise<ZapierStatus> {
    const { data } = await axiosClient.post<ZapierStatus>('/zapier/refresh');
    return data;
  },

  async disconnect(): Promise<void> {
    await axiosClient.delete('/zapier/connect');
  },

  async createWebhookSource(payload: CreateWebhookSourcePayload): Promise<WebhookSourceCreated> {
    const { data } = await axiosClient.post<WebhookSourceCreated>('/data-sources/webhook-sources', payload);
    return data;
  },

  async rotateWebhookKey(id: string): Promise<WebhookSourceCreated> {
    const { data } = await axiosClient.post<WebhookSourceCreated>(`/data-sources/webhook-sources/${id}/rotate-key`);
    return data;
  },

  async disconnectWebhookSource(id: string): Promise<void> {
    await axiosClient.delete(`/data-sources/webhook-sources/${id}`);
  },
};
