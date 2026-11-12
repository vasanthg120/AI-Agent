import { axiosClient } from '@/api/axiosClient';

// The deal panel (backend/src/deal-insight): everything recorded about one
// deal, and the AI's brief on it — written only when someone clicks Analyse.

export type LeadStatus = 'new_lead' | 'contacted' | 'interested' | 'negotiation' | 'quote_sent' | 'awaiting_response' | 'follow_up_required' | 'payment_pending' | 'won' | 'lost';
export type Urgency = 'now' | 'today' | 'this_week' | 'later';

export interface DealBrief {
  statusLabel: string;
  leadStatus?: LeadStatus;
  leadStatusReason?: string;
  observedFacts?: string[];
  inferences?: string[];
  emailSummary?: string;
  emailInsights?: { questions: string[]; commitments: string[]; pricing: string[]; objections: string[]; competitors: string[] };
  crmOverview?: string;
  recommendations?: { action: string; why: string; urgency: Urgency }[];
  nextBestAction?: { action: string; why: string; urgency: Urgency; deadline: string };
  health: 'on_track' | 'needs_attention' | 'at_risk' | 'won' | 'lost';
  winLikelihood: 'high' | 'medium' | 'low' | 'closed';
  winLikelihoodReason: string;
  summary: string;
  lastContact: string;
  waitingOn: 'us' | 'customer' | 'nobody' | 'unknown';
  customerNeeds: string[];
  risks: string[];
  nextAction: string;
  plan: { step: string; owner: 'salesperson' | 'manager' | 'customer'; when: string }[];
  missingInfo: string[];
  suggestedMessage: string;
  generatedAt: string;
  // Something new arrived for the deal since it was written.
  stale: boolean;
}

export interface DealEmail {
  id: string;
  direction: 'in' | 'out';
  at: string;
  subject: string;
  from?: string;
  to?: string;
  preview: string;
  summary?: string;
  waitingForReply?: boolean;
  repliedAt?: string;
  mailboxOwner?: string;
}

export interface DealCall {
  id: string;
  at: string;
  kind: 'phone' | 'live' | 'upload';
  personName: string;
  durationSeconds?: number;
  connected: boolean;
  sessionId?: string;
  headline?: string;
  outcome?: string;
  score?: number;
  summaryPoints: string[];
  followUps: string[];
}

export interface DealOverview {
  deal: {
    id: string;
    name: string;
    status: 'open' | 'won' | 'lost';
    value: number;
    currency: string;
    stage?: string;
    expectedClosingDate?: string;
    closedAt?: string;
    createdAt?: string;
    lastActivityAt?: string;
    leadSource?: string;
    product?: string;
    lostReason?: string;
    provider?: string;
    ownerName?: string;
    crmOwner?: string;
    businessName: string;
  };
  customer: { name?: string; company?: string; email?: string; phone?: string; addresses: string[] };
  quotes: { id: string; number?: string; name?: string; amount: number; currency: string; status: string; approval?: string; createdAt?: string; expires?: string; owner?: string }[];
  notes: { id: string; body: string; at?: string; by?: string }[];
  emails: DealEmail[];
  calls: DealCall[];
  history: { at: string; kind: string; entity: string; ref?: string; from?: string; to?: string; value?: number; by?: string; byAi: boolean }[];
  stats: { emailsIn: number; emailsOut: number; waitingForReply: number; calls: number; notes: number; quotes: number; lastContactAt?: string; daysSinceLastContact?: number };
  health: DealHealth;
  tasks: DealTask[];
  assignments: { at: string; from?: string; to?: string; by?: string; reason?: string }[];
  actions: DealAgentAction[];
  brief: DealBrief | null;
}

export interface DealHealth {
  score: number | null;
  band: 'healthy' | 'watch' | 'at_risk' | 'closed';
  factors: { key: string; label: string; points: number; max: number; detail: string }[];
  risks: string[];
  improvements: string[];
}

export interface DealTask {
  id: string;
  title: string;
  dueDate?: string;
  status: 'open' | 'done';
  overdue: boolean;
  assignee?: string;
  byAi: boolean;
  createdAt?: string;
  completedAt?: string;
}

export type DealActionType = 'create_task' | 'add_note' | 'notify_owner' | 'draft_email';

export interface DealAgentAction {
  id: string;
  type: DealActionType;
  status: 'done' | 'failed' | 'duplicate';
  summary: string;
  error?: string;
  by?: string;
  at: string;
}

export interface DealActionRequest {
  type: DealActionType;
  idempotencyKey: string;
  title?: string;
  dueDate?: string;
  text?: string;
  subject?: string;
}

export const dealInsightService = {
  async overview(dealId: string): Promise<DealOverview> {
    const { data } = await axiosClient.get<DealOverview>(`/deal-insight/${dealId}`);
    return data;
  },

  async analyse(dealId: string): Promise<DealBrief> {
    const { data } = await axiosClient.post<DealBrief>(`/deal-insight/${dealId}/analyse`);
    return data;
  },

  /** An action the AI proposed, approved by the person clicking it. */
  async runAction(dealId: string, request: DealActionRequest): Promise<DealAgentAction> {
    const { data } = await axiosClient.post<DealAgentAction>(`/deal-insight/${dealId}/actions`, request);
    return data;
  },

  async setTaskDone(dealId: string, taskId: string, done: boolean): Promise<DealTask> {
    const { data } = await axiosClient.patch<DealTask>(`/deal-insight/${dealId}/tasks/${taskId}`, { done });
    return data;
  },
};
