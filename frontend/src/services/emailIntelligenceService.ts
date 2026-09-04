import { axiosClient } from '@/api/axiosClient';

export const EMAIL_INTELLIGENCE_INTENTS = [
  'new_enquiry',
  'existing_customer',
  'quotation_request',
  'price_negotiation',
  'complaint',
  'technical_support',
  'payment',
  'purchase_order',
  'vendor',
  'refund',
  'meeting_request',
  'escalation',
  'internal',
  'spam',
  'other',
] as const;

// Vendor/customer/enquiry-related intents — the ones a salesperson actually
// needs to act on, vs. the payment confirmations/internal mail/other noise
// that a real connected mailbox also gets classified alongside them (confirmed
// live: one real inbox's queue was ~80% "other"). An explicit allow-list, not
// an exclude-list, so a new intent value added later defaults to hidden by
// this filter until deliberately added here — never silently shown as
// "relevant" without a real decision.
export const RELEVANT_EMAIL_INTENTS: (typeof EMAIL_INTELLIGENCE_INTENTS)[number][] = [
  'vendor',
  'existing_customer',
  'new_enquiry',
  'quotation_request',
  'price_negotiation',
  'complaint',
  'technical_support',
  'escalation',
  'meeting_request',
];

export interface MatchedQuoteSummary {
  quoteNumber?: string;
  quoteName?: string;
  quoteAmount: number;
  currency: string;
  quoteStatus: string;
}

export interface MatchedBusinessSummary {
  openDealCount: number;
  wonDealCount: number;
  // Never a cost/margin/discount field — no real pricing data exists yet
  // (see Phase 14b plan notes).
  previousQuotes: MatchedQuoteSummary[];
}

export interface EmailIntelligenceItem {
  _id: string;
  organizationId: string;
  userId: string;
  mailboxEmail: string;
  externalMessageId: string;
  receivedAt: string;
  subject: string;
  fromAddress: string;
  toAddresses: string[];
  bodyPreview: string;
  isRead: boolean;
  importance: string;
  matchConfidence: 'exact' | 'domain' | 'fuzzy' | 'none';
  matchedBusinessKey?: string;
  matchedBusinessName?: string;
  matchedBusinessSummary?: MatchedBusinessSummary;
  intent: (typeof EMAIL_INTELLIGENCE_INTENTS)[number];
  priority: 'low' | 'medium' | 'high' | 'urgent';
  urgency: 'low' | 'medium' | 'high' | 'urgent';
  sentiment: 'positive' | 'neutral' | 'negative' | 'frustrated';
  recommendedAction: string;
  shouldDraft: boolean;
  draftReply?: string;
  draftReasoning?: string;
  // Phase 17 — perspective-correctness fields, all deterministically computed
  // server-side (see backend/src/email-intelligence/email-intelligence.service.ts).
  // Absent on documents created before Phase 17 — render a neutral fallback.
  fromRole?: 'internal' | 'customer' | 'vendor' | 'external_other';
  expectedNextAction?: 'company_reply' | 'awaiting_customer' | 'no_action_required';
  aiStatus?: 'draft_ready' | 'no_reply_needed' | 'awaiting_customer_response' | 'validation_failed';
  reason?: string;
  status: 'pending' | 'approved' | 'rejected';
  finalDraftReply?: string;
  wasEdited: boolean;
  approvedAt?: string;
  approvedBy?: string;
  rejectedAt?: string;
  rejectedBy?: string;
  rejectionReason?: string;
  regeneratedCount: number;
  lastRegeneratedAt?: string;
  // Phase 14d — set only after a real, successful send. Absence with
  // status === 'approved' means "approved but not yet sent."
  sentAt?: string;
  sendError?: string;
  // Set when a reply was detected directly in the mailbox owner's real
  // Outlook client (same-thread outbound message, found via Sent Items
  // cross-reference during sync) — never through this app's own send flow,
  // which is what sentAt above means instead. See EmailIntelligenceSyncService.
  externalReplyDetectedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// Phase 14e — a small, dedicated follow-up reminder, created automatically
// after a real send (never inserted into the Todo/EOD DailyReport.tasks
// array, which gets wholesale-replaced on every scheduled report run).
export interface EmailFollowUpReminder {
  _id: string;
  organizationId: string;
  userId: string;
  emailIntelligenceItemId: string;
  businessName?: string;
  title: string;
  dueDate: string;
  status: 'pending' | 'done' | 'dismissed';
  reminderType: string;
  draftReply?: string;
  draftStatus: 'none' | 'generating' | 'pending_review' | 'approved' | 'sent' | 'failed';
  draftGeneratedAt?: string;
  sentAt?: string;
  sendError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SyncMailboxResult {
  connected: boolean;
  scannedCount: number;
  newItemsCount: number;
}

// Phase 21 follow-up — genuinely richer than SyncMailboxResult now: breaks
// "new" down into what's already stored, what the deterministic gates would
// auto-skip (no LLM cost), and what would actually spend a real AI call,
// plus a real (never guessed) token estimate once history exists.
export interface SyncPreviewResult {
  connected: boolean;
  scannedCount: number;
  alreadyAnalyzedCount: number;
  autoSkippedCount: number;
  willAnalyzeCount: number;
  estimatedInputTokens: number | null;
  estimatedOutputTokens: number | null;
  estimatedBasis: 'historical_average' | 'no_history';
  lastSyncedAt: string | null;
}

export interface EmailSyncJob {
  _id: string;
  // 'completed_with_errors' distinguishes "ran, but some/all items failed"
  // (e.g. a real Anthropic outage) from a genuinely clean run — 'failed' is
  // reserved for the sync operation itself throwing before it finished.
  status: 'completed' | 'completed_with_errors' | 'failed';
  scannedCount: number;
  newItemsCount: number;
  succeededCount: number;
  failedCount: number;
  // 'scheduled' — the background half-hourly sync (see
  // email-intelligence-sync.service.ts's runScheduledSync); 'user' — an
  // explicit Sync Inbox click.
  triggeredBy: 'user' | 'scheduled';
  startedAt: string;
  completedAt: string;
  createdAt: string;
}

export interface ProviderHealthStatus {
  provider: 'anthropic' | 'groq';
  status: 'available' | 'degraded' | 'unknown';
  lastCheckedAt: string | null;
  lastError: string | null;
}

export const emailIntelligenceService = {
  // The only way this feature ever spends an LLM call outside of an explicit
  // approve/reject/regenerate/send action — nothing runs automatically in
  // the background (see backend/src/email-intelligence/
  // email-intelligence-sync.service.ts's own comment for why the old
  // always-on 3-minute cron was removed).
  async sync(): Promise<SyncMailboxResult> {
    const { data } = await axiosClient.post<SyncMailboxResult>('/email-intelligence/sync');
    return data;
  },

  // Phase 21 — cheap, LLM-free count of new mail, called before sync() so
  // the caller can confirm a real operation count rather than spending
  // credit blind.
  async previewSync(): Promise<SyncPreviewResult> {
    const { data } = await axiosClient.get<SyncPreviewResult>('/email-intelligence/sync/preview');
    return data;
  },

  async getRecentSyncJobs(): Promise<EmailSyncJob[]> {
    const { data } = await axiosClient.get<EmailSyncJob[]>('/email-intelligence/sync/jobs');
    return data;
  },

  // Phase 21 follow-up — surfaced on the page before the user clicks Sync,
  // so a credit/outage issue is visible up front rather than discovered
  // only after spending a click on a sync that will fail.
  async getProviderHealth(): Promise<ProviderHealthStatus[]> {
    const { data } = await axiosClient.get<ProviderHealthStatus[]>('/email-intelligence/provider-health');
    return data;
  },

  async list(
    status?: 'pending' | 'approved' | 'rejected',
    range?: { from?: string; to?: string },
  ): Promise<EmailIntelligenceItem[]> {
    const { data } = await axiosClient.get<EmailIntelligenceItem[]>('/email-intelligence', {
      params: { ...(status ? { status } : {}), ...(range?.from ? { from: range.from } : {}), ...(range?.to ? { to: range.to } : {}) },
    });
    return data;
  },

  async getOne(id: string): Promise<EmailIntelligenceItem> {
    const { data } = await axiosClient.get<EmailIntelligenceItem>(`/email-intelligence/${id}`);
    return data;
  },

  // Phase 19 — the Unified Analytics Dashboard's email activity widget.
  // Owner/manager get an org/store-wide aggregate here (a deliberate,
  // narrow exception to every other route on this service being self-
  // scoped only); consultant sees their own mailbox, same as everywhere
  // else. Takes a raw from/to range — the dashboard always passes its own
  // page-level dateFrom/dateTo (see CustomersAndEmailSection), so this
  // widget shares the same single month/year filter as the rest of the page.
  async getActivityStats(
    from: string,
    to: string,
  ): Promise<{
    totalRelevantCount: number;
    sentCount: number;
    missedCount: number;
    newEnquiryCount: number;
    byIntent: { intent: string; label: string; receivedCount: number; sentCount: number }[];
  }> {
    const { data } = await axiosClient.get('/email-intelligence/activity-stats', { params: { from, to } });
    return data;
  },

  // kind:'intent' + an intent value drills into one business-mail category
  // (vendor, new enquiry, existing customer, etc.).
  async listActivity(kind: 'sent' | 'missed' | 'intent', from: string, to: string, intent?: string): Promise<EmailIntelligenceItem[]> {
    const { data } = await axiosClient.get<EmailIntelligenceItem[]>('/email-intelligence/activity-query', {
      params: { kind, from, to, ...(intent ? { intent } : {}) },
    });
    return data;
  },

  async approve(id: string, finalDraftReply?: string): Promise<EmailIntelligenceItem> {
    const { data } = await axiosClient.post<EmailIntelligenceItem>(`/email-intelligence/${id}/approve`, { finalDraftReply });
    return data;
  },

  async reject(id: string, reason?: string): Promise<EmailIntelligenceItem> {
    const { data } = await axiosClient.post<EmailIntelligenceItem>(`/email-intelligence/${id}/reject`, { reason });
    return data;
  },

  async regenerate(id: string): Promise<EmailIntelligenceItem> {
    const { data } = await axiosClient.post<EmailIntelligenceItem>(`/email-intelligence/${id}/regenerate`);
    return data;
  },

  // Phase 14d — the only call that actually dispatches a real email. Only
  // valid on an already-approved item; the caller is responsible for its
  // own confirmation step before invoking this (see EmailIntelligenceDetailModal.tsx).
  async send(id: string): Promise<EmailIntelligenceItem> {
    const { data } = await axiosClient.post<EmailIntelligenceItem>(`/email-intelligence/${id}/send`);
    return data;
  },

  // Phase 14e
  async getFollowUps(): Promise<EmailFollowUpReminder[]> {
    const { data } = await axiosClient.get<EmailFollowUpReminder[]>('/email-intelligence/follow-ups');
    return data;
  },

  async markFollowUpDone(id: string): Promise<EmailFollowUpReminder> {
    const { data } = await axiosClient.post<EmailFollowUpReminder>(`/email-intelligence/follow-ups/${id}/done`);
    return data;
  },

  // AI Follow-up action layer — gated behind AI_FOLLOWUP_ACTIONS_ENABLED
  // server-side; never auto-sends, always requires an explicit approve
  // click before sendFollowUp is callable (see email-sla plan).
  async generateFollowUpDraft(id: string): Promise<EmailFollowUpReminder> {
    const { data } = await axiosClient.post<EmailFollowUpReminder>(`/email-intelligence/follow-ups/${id}/draft`);
    return data;
  },

  async approveFollowUpDraft(id: string, finalDraftReply?: string): Promise<EmailFollowUpReminder> {
    const { data } = await axiosClient.post<EmailFollowUpReminder>(`/email-intelligence/follow-ups/${id}/approve`, { finalDraftReply });
    return data;
  },

  async sendFollowUp(id: string): Promise<EmailFollowUpReminder> {
    const { data } = await axiosClient.post<EmailFollowUpReminder>(`/email-intelligence/follow-ups/${id}/send`);
    return data;
  },
};
