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

// How the owner of a mailbox wants its replies handled.
export interface EmailInboxSettings {
  // The AI writes drafts for waiting mail without being asked each time.
  autoDraft: boolean;
  // Approving a reply sends it (one step). Off: approving only saves it.
  sendOnApprove: boolean;
}

export interface EmailDraftRun {
  startedAt: string;
  finishedAt?: string;
  drafted: number;
  // Read by the AI, nothing drafted: no reply needed, or one to write by hand.
  noDraft: number;
  // Why the run stopped early (credits used up, the AI unreachable).
  error?: string;
}

export interface EmailDraftSummary {
  waiting: number;
  withDraft: number;
  // Waiting, no draft, never read by the AI — what "Draft with AI" works through.
  withoutDraft: number;
  recentWithoutDraft: number;
  autoDraftWindowDays: number;
  settings: EmailInboxSettings;
  running: boolean;
  last: EmailDraftRun | null;
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
  // False for mail the AI has not read (imported history, or the AI was unavailable when it arrived).
  aiRead?: boolean;
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
  // Set when a LATER reply in the same conversation answered this message.
  threadRespondedAt?: string;
  conversationId?: string;
  // Derived by the backend (never stored, never guessed here) from the fields
  // above — see backend/src/email-intelligence/email-response-state.ts. THE
  // answer to "does this still need a reply": `status` above is only the
  // AI-draft approval lifecycle, so an email answered directly in Outlook is
  // still status:'pending' but is 'responded' here.
  responseStatus: EmailResponseStatus;
  respondedAt?: string;
  respondedVia?: EmailRespondedVia;
  // The conversation's single category, derived by the backend from the same facts.
  category?: EmailCategory;
  // The sender's name as Outlook shows it.
  fromName?: string;
  // How many customer messages the conversation holds (a row is one conversation).
  threadMessageCount?: number;
  // The opening words of what we last wrote back.
  replyPreview?: string;
  replyAwaitsCustomer?: boolean;
  // 'pending': stored and tracked, but not read by the AI yet (no credits / AI unavailable).
  analysisState?: 'pending' | 'failed';
  analysisError?: string;
  // The email was deleted in Outlook.
  mailboxState?: 'deleted' | 'gone';
  createdAt: string;
  updatedAt: string;
}

export type EmailResponseStatus = 'needs_response' | 'responded' | 'resolved';
export type EmailRespondedVia = 'app' | 'outlook' | 'thread';
export type EmailCategory =
  | 'urgent'
  | 'needs_response'
  | 'waiting_for_customer'
  | 'follow_up_required'
  | 'responded'
  | 'informational'
  | 'completed';

export type EmailInboxCounts = Record<EmailResponseStatus, number> & { categories?: Record<EmailCategory, number> };

export interface ReplyRefreshResult {
  connected: boolean;
  answered: number;
  checked: boolean;
}

export interface EmailSyncState {
  lastSyncedAt: string | null;
  running: boolean;
  awaitingAnalysis: number;
}

export interface EmailThreadSentMessage {
  id: string;
  subject: string;
  to: string[];
  sentAt: string;
  preview: string;
}

export interface EmailListParams {
  // The inbox question: still needs a reply / already answered / nothing to do.
  view?: EmailResponseStatus;
  // The AI-draft approval lifecycle, for callers that mean exactly that.
  status?: 'pending' | 'approved' | 'rejected';
  dateFrom?: string;
  dateTo?: string;
  intents?: string[];
  search?: string;
  sort?: 'urgency' | 'newest' | 'oldest';
  limit?: number;
  skip?: number;
}

// The stored messages of one conversation, oldest first, each with its own
// derived response state.
export interface EmailThread {
  // What we sent back in this conversation, as stored from Outlook's Sent Items.
  sent?: EmailThreadSentMessage[];
  conversationId: string | null;
  messages: Pick<
    EmailIntelligenceItem,
    | '_id'
    | 'subject'
    | 'fromAddress'
    | 'receivedAt'
    | 'bodyPreview'
    | 'isRead'
    | 'intent'
    | 'priority'
    | 'status'
    | 'shouldDraft'
    | 'aiStatus'
    | 'sendError'
    | 'responseStatus'
    | 'respondedAt'
    | 'respondedVia'
  >[];
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
  // AI Follow-up Agent (SLA-breach trigger) additions — always absent on
  // the existing 'post_reply' reminder type.
  slaRecordId?: string;
  dismissedAt?: string;
  dismissedReason?: string;
  // Real per-generation facts, not a static capability flag — only ever set
  // once a draft has actually been generated for this reminder.
  contextUsed?: { thread: boolean; crm: boolean; businessKnowledge: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface SyncMailboxResult {
  connected: boolean;
  scannedCount: number;
  newItemsCount: number;
  // New mail stored without an AI reading (no credits / AI unavailable) — tracked and retried.
  deferredCount?: number;
  answeredCount?: number;
  alreadyRunning?: boolean;
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

// Empty filters are left off the wire entirely (the backend reads "absent" as
// "no filter"); the date range's dateFrom/dateTo become the API's from/to.
function toQueryParams(params: EmailListParams): Record<string, string | number> {
  const query: Record<string, string | number> = {};
  if (params.view) query.view = params.view;
  if (params.status) query.status = params.status;
  if (params.dateFrom) query.from = params.dateFrom;
  if (params.dateTo) query.to = params.dateTo;
  if (params.intents?.length) query.intents = params.intents.join(',');
  if (params.search?.trim()) query.search = params.search.trim();
  if (params.sort) query.sort = params.sort;
  if (params.limit !== undefined) query.limit = params.limit;
  if (params.skip !== undefined) query.skip = params.skip;
  return query;
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

  // The cheap reply check: reads Outlook's Sent Items only (no new mail, no
  // AI) and settles which waiting emails have been answered. Safe to call
  // often — the backend rate-limits it per mailbox.
  async refreshReplies(): Promise<ReplyRefreshResult> {
    const { data } = await axiosClient.post<ReplyRefreshResult>('/email-intelligence/sync/replies');
    return data;
  },

  async syncState(): Promise<EmailSyncState> {
    const { data } = await axiosClient.get<EmailSyncState>('/email-intelligence/sync/state');
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

  async list(params: EmailListParams = {}): Promise<EmailIntelligenceItem[]> {
    const { data } = await axiosClient.get<EmailIntelligenceItem[]>('/email-intelligence', {
      params: toQueryParams(params),
    });
    return data;
  },

  // The tab badges — same filters as list(), so a count always equals the rows
  // behind it.
  async counts(
    params: Pick<EmailListParams, 'dateFrom' | 'dateTo' | 'intents' | 'search'> = {},
  ): Promise<EmailInboxCounts> {
    const { data } = await axiosClient.get<EmailInboxCounts>('/email-intelligence/counts', {
      params: toQueryParams(params),
    });
    return data;
  },

  async getThread(id: string): Promise<EmailThread> {
    const { data } = await axiosClient.get<EmailThread>(`/email-intelligence/${id}/thread`);
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
  async listActivity(
    kind: 'sent' | 'missed' | 'intent',
    from: string,
    to: string,
    intent?: string,
  ): Promise<EmailIntelligenceItem[]> {
    const { data } = await axiosClient.get<EmailIntelligenceItem[]>('/email-intelligence/activity-query', {
      params: { kind, from, to, ...(intent ? { intent } : {}) },
    });
    return data;
  },

  // "Approve & send": the reply as it stands in the box — the AI's draft, an
  // edit of it, or your own words — approved and sent in one step.
  async reply(id: string, text: string): Promise<EmailIntelligenceItem> {
    const { data } = await axiosClient.post<EmailIntelligenceItem>(`/email-intelligence/${id}/reply`, { text });
    return data;
  },

  // How many waiting emails have a draft, the owner's reply settings, and
  // whether the AI is writing drafts right now.
  async getDraftSummary(): Promise<EmailDraftSummary> {
    const { data } = await axiosClient.get<EmailDraftSummary>('/email-intelligence/drafts/summary');
    return data;
  },

  // Starts the AI on the waiting emails that have no draft (billed AI calls).
  // Returns at once; getDraftSummary reports progress.
  async runDrafts(limit: number): Promise<{ started: boolean; alreadyRunning: boolean }> {
    const { data } = await axiosClient.post<{ started: boolean; alreadyRunning: boolean }>(
      '/email-intelligence/drafts/run',
      { limit },
    );
    return data;
  },

  async updateInboxSettings(settings: Partial<EmailInboxSettings>): Promise<EmailInboxSettings> {
    const { data } = await axiosClient.put<EmailInboxSettings>('/email-intelligence/settings', settings);
    return data;
  },

  async approve(id: string, finalDraftReply?: string): Promise<EmailIntelligenceItem> {
    const { data } = await axiosClient.post<EmailIntelligenceItem>(`/email-intelligence/${id}/approve`, {
      finalDraftReply,
    });
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

  // AI Follow-up action layer — a billed AI call, made because someone asked
  // for the draft; never auto-sends, always requires an explicit approve
  // click before sendFollowUp is callable (see email-sla plan).
  async generateFollowUpDraft(id: string): Promise<EmailFollowUpReminder> {
    const { data } = await axiosClient.post<EmailFollowUpReminder>(`/email-intelligence/follow-ups/${id}/draft`);
    return data;
  },

  async approveFollowUpDraft(id: string, finalDraftReply?: string): Promise<EmailFollowUpReminder> {
    const { data } = await axiosClient.post<EmailFollowUpReminder>(`/email-intelligence/follow-ups/${id}/approve`, {
      finalDraftReply,
    });
    return data;
  },

  async sendFollowUp(id: string): Promise<EmailFollowUpReminder> {
    const { data } = await axiosClient.post<EmailFollowUpReminder>(`/email-intelligence/follow-ups/${id}/send`);
    return data;
  },

  async dismissFollowUp(id: string, reason?: string): Promise<EmailFollowUpReminder> {
    const { data } = await axiosClient.post<EmailFollowUpReminder>(`/email-intelligence/follow-ups/${id}/dismiss`, {
      reason,
    });
    return data;
  },

  // ---- mailbox history, sent mail, follow-up analysis ----

  async getHistoryStatus(): Promise<MailboxHistoryStatus> {
    const { data } = await axiosClient.get<MailboxHistoryStatus>('/email-intelligence/history/status');
    return data;
  },

  // Loads older inbox + sent mail from Outlook (no AI calls). A large mailbox can take a few minutes.
  async importHistory(days: number): Promise<HistoryImportResult> {
    const { data } = await axiosClient.post<HistoryImportResult>(
      '/email-intelligence/history/import',
      { days },
      { timeout: 600_000 },
    );
    return data;
  },

  async listSent(
    params: { search?: string; skip?: number; limit?: number } = {},
  ): Promise<{ total: number; items: SentEmail[] }> {
    const { data } = await axiosClient.get<{ total: number; items: SentEmail[] }>('/email-intelligence/sent', {
      params: { search: params.search || undefined, skip: params.skip, limit: params.limit },
    });
    return data;
  },

  async getFollowUpAnalysis(): Promise<FollowUpAnalysis> {
    const { data } = await axiosClient.get<FollowUpAnalysis>('/email-intelligence/follow-up-analysis');
    return data;
  },

  // Makes a follow-up row a real reminder, so it can be drafted, approved and sent like the others.
  async ensureFollowUpReminder(emailId: string): Promise<EmailFollowUpReminder> {
    const { data } = await axiosClient.post<EmailFollowUpReminder>(
      `/email-intelligence/follow-up-analysis/${emailId}/reminder`,
    );
    return data;
  },
};

export interface MailboxHistoryStatus {
  inboxCount: number;
  sentCount: number;
  oldestInboxAt: string | null;
  oldestSentAt: string | null;
  maxDays: number;
}

export interface HistoryImportResult {
  connected: boolean;
  days: number;
  inboxScanned: number;
  inboxAdded: number;
  sentScanned: number;
  sentAdded: number;
  markedResponded: number;
  // The range held more mail than one import reads — load a shorter range to get the rest.
  truncated: boolean;
}

export interface SentEmail {
  id: string;
  subject: string;
  to: string[];
  sentAt: string;
  preview: string;
}

export type FollowUpBucket = 'not_responded' | 'follow_up_required' | 'overdue_follow_up';

export interface FollowUpRow {
  id: string;
  bucket: FollowUpBucket;
  kind: 'unanswered' | 'promised_follow_up' | 'awaiting_customer' | 'reminder';
  emailId: string;
  reminderId?: string;
  customer: string;
  company?: string;
  subject: string;
  lastCustomerMessage?: { preview: string; at: string };
  lastResponseAt?: string;
  daysWaiting: number;
  reason: string;
  suggestedAction: string;
  suggestedMessage?: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
}

export interface FollowUpAnalysis {
  counts: Record<FollowUpBucket | 'responded', number>;
  rows: FollowUpRow[];
}
