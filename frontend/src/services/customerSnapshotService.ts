import { axiosClient } from '@/api/axiosClient';
import type { BadgeVariant } from '@/components/ui';

export interface SnapshotEmail {
  id: string;
  subject: string;
  direction: 'received' | 'sent';
  at: string;
  needsReply: boolean;
  preview?: string;
  /** Received: the AI's one-line reading, what it asks for, and its tone. */
  aiSummary?: string;
  intent?: string;
  sentiment?: string;
  mailbox?: string;
}

export interface SnapshotDetails {
  contact: { email?: string; phone?: string; owner?: string };
  why: { label: string; reasons: string[] }[];
  needs: string[];
  concerns: string[];
  quotes: { id: string; number?: string; name?: string; amount: number; state: string; date?: string }[];
  deals: { id: string; name?: string; status: 'open' | 'won' | 'lost'; value: number; createdAt?: string }[];
  emails: SnapshotEmail[];
  crm: { enquiry?: { at?: string; source: string; lines: string[] }; history: { at: string; text: string }[] };
  calls: {
    id: string;
    at: string;
    direction: string;
    missed: boolean;
    connected: boolean;
    durationSeconds?: number;
    employee?: string;
    summary?: string;
    score?: number;
    sessionId?: string;
  }[];
}

type Cited = { evidence: string[] };

export interface SnapshotAiReport {
  summary: string;
  buyingIntent: { level: 'very_high' | 'high' | 'medium' | 'low' | 'unknown'; reason: string } & Cited;
  sentiment: { overall: 'positive' | 'neutral' | 'negative' | 'mixed' | 'unknown'; trend: string; reason: string } & Cited;
  behaviours: ({ trait: string; explanation: string } & Cited)[];
  painPoints: ({ text: string } & Cited)[];
  competitors: ({ name: string; context: string; pricing?: string; risk: string; response: string } & Cited)[];
  insights: ({ text: string; basis: 'fact' | 'inference' } & Cited)[];
  recommendations: ({ action: string; reason: string; priority: 'high' | 'medium' | 'low'; deadline: string; outcome: string } & Cited)[];
  preferences: ({ kind: string; text: string } & Cited)[];
}

export interface SnapshotAi {
  status: 'ready' | 'outdated' | 'none';
  canRun: boolean;
  generatedAt?: string;
  reads: { emails: number; calls: number; crm: number; quotations: number };
  report?: SnapshotAiReport;
  /** What each cited evidence id stands for. */
  sources: Record<string, string>;
}

// The customer on a call — backend Customer360Service.snapshot: a few lines up
// front, and more behind "Show more" (the AI's profile, emails, CRM history…).
export type CustomerSnapshot =
  | { found: false }
  | { found: true; restricted: true }
  | {
      found: true;
      restricted?: false;
      customer: { id: string; name: string; company?: string };
      currency: string;
      stage: { label: string; tone: BadgeVariant; reason: string };
      flags: { key: string; label: string; tone: BadgeVariant; reason: string }[];
      orders: number;
      revenue: number;
      openQuotes: number;
      openQuoteValue: number;
      lastContactAt?: string;
      health: { score: number | null; band: string; label: string };
      unansweredEmails: number;
      lastCall?: { at: string; summary?: string };
      nextSteps: string[];
      ai: SnapshotAi;
      details: SnapshotDetails;
    };

/** Which customer: the call's deal, the number dialled, or a recorded call in the library. */
export interface SnapshotRef {
  dealId?: string;
  phone?: string;
  sessionId?: string;
}

const paramsOf = (ref: SnapshotRef) => {
  const params: Record<string, string> = {};
  if (ref.dealId) params.dealId = ref.dealId;
  if (ref.phone) params.phone = ref.phone;
  if (ref.sessionId) params.sessionId = ref.sessionId;
  return params;
};

export const customerSnapshotService = {
  async get(ref: SnapshotRef): Promise<CustomerSnapshot> {
    const { data } = await axiosClient.get<CustomerSnapshot>('/call-copilot/customer-snapshot', { params: paramsOf(ref) });
    return data;
  },

  // The AI's profile — billed; reused by the server until something new happens with the customer.
  async analyze(ref: SnapshotRef, refresh = false): Promise<CustomerSnapshot> {
    const { data } = await axiosClient.post<CustomerSnapshot>(
      '/call-copilot/customer-snapshot/analyze',
      {},
      { params: { ...paramsOf(ref), ...(refresh ? { refresh: 'true' } : {}) }, timeout: 130_000 },
    );
    return data;
  },
};
