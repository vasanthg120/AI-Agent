import { axiosClient } from '@/api/axiosClient';

// Live source data (backend/src/live-data): pages show what the connected sources hold now.
// When a page opens it asks the server to read what changed in each live CRM (and the
// mailbox), then watches the status until those reads land. Hoops is read once a night
// (its own rule), so it is reported as "nightly", never read here.

export type LiveScope = 'business' | 'all';

export interface LiveSource {
  id: string;
  label: string;
  provider: string;
  businessId: string;
  businessName: string;
  /** live: read whenever a page needs it. nightly: the CRM allows one read a night (Hoops). */
  mode: 'live' | 'nightly';
  lastSyncAt: string | null;
  refreshing: boolean;
  error?: string;
  nextNightlyAt?: string | null;
}

export interface LiveMailbox {
  connected: boolean;
  lastFetchedAt: string | null;
  fetching: boolean;
  /** Emails stored but not read by the AI yet. */
  awaitingAi: number;
  /** The AI is reading newly fetched mail right now. */
  aiReading: boolean;
}

export interface LiveStatus {
  checkedAt: string;
  sources: LiveSource[];
  mailbox?: LiveMailbox;
}

export const liveDataService = {
  /** crm false: the mailbox only (the AI Email Inbox). */
  async refresh(scope: LiveScope, email: boolean, crm = true): Promise<LiveStatus> {
    const { data } = await axiosClient.post<LiveStatus>('/live/refresh', { scope, email, crm });
    return data;
  },

  async status(scope: LiveScope, email: boolean): Promise<LiveStatus> {
    const { data } = await axiosClient.get<LiveStatus>('/live/status', { params: { scope, email } });
    return data;
  },
};
