// The one definition of "has this email been answered, and does it still need
// an answer" for the AI Email Inbox — and every dashboard/report that counts
// pending or missed mail.
//
// Before this existed, `status` (the AI-draft approval lifecycle: pending/
// approved/rejected) was being read as if it meant "answered or not", and each
// consumer re-implemented its own slightly different version of "pending":
//   - a reply typed directly into Outlook set externalReplyDetectedAt but left
//     status:'pending', so the item stayed in the Pending queue and, after 24h,
//     in "missed" on the business dashboard (which didn't even check that field);
//   - a reply sent through the app only resolved that one message, never the
//     rest of its thread;
//   - an approved draft whose send FAILED left status:'approved' with no reply
//     ever sent — hidden from Pending, looking handled;
//   - "no reply needed" mail (AI said so) still counted as pending/missed.
//
// Nothing here is stored: the state is derived from fields the backend already
// owns and only ever moves one way (sentAt / externalReplyDetectedAt /
// threadRespondedAt are set, never cleared — sync, polling, AI re-analysis and
// read/unread changes never touch them), so it cannot drift and needs no
// migration. `deriveResponseStatus` (for one document) and the *_MATCH filters
// (for queries) are two spellings of the same rules — keep them identical; the
// spec pins them against each other.

export type EmailResponseStatus =
  // Somebody has to answer this and nobody has (includes an approved draft that
  // hasn't gone out, and one whose send failed).
  | 'needs_response'
  // Answered — through this app, directly in Outlook, or by a later reply in
  // the same thread.
  | 'responded'
  // Nothing more to do and nobody replied: rejected/dismissed, or the AI
  // decided no reply is owed (or the user approved it as "no reply needed").
  | 'resolved';

export type EmailRespondedVia = 'app' | 'outlook' | 'thread';

// One label per conversation, finer than the three views above and never two at
// once: what the row is, read from the same stored facts.
export type EmailCategory =
  | 'urgent' // needs a reply, and soon
  | 'needs_response'
  | 'waiting_for_customer' // we replied and asked them something
  | 'follow_up_required' // …and they have been silent for a while
  | 'responded' // we replied; nothing is pending either way
  | 'informational' // no reply was ever needed
  | 'completed'; // closed by a person: dismissed, or the email was deleted in Outlook

/** How long a customer may leave our question unanswered before the conversation is flagged for a follow-up. */
export const FOLLOW_UP_AFTER_DAYS = 3;

export interface ResponseStateFields {
  status?: string;
  shouldDraft?: boolean;
  expectedNextAction?: string;
  aiStatus?: string;
  sentAt?: Date;
  externalReplyDetectedAt?: Date;
  threadRespondedAt?: Date;
  // False on an older message of a conversation in which the customer has
  // since written again: the conversation is represented by its newest
  // message, so the older one neither needs nor shows its own reply state.
  threadHead?: boolean;
  // The message was deleted in Outlook (or is no longer in the mailbox).
  mailboxRemovedAt?: Date;
  priority?: string;
  urgency?: string;
  // Our reply asked the customer for something (see replyAwaitsCustomer).
  replyAwaitsCustomer?: boolean;
}

/** Mongo: nobody has answered this message. */
export const UNANSWERED_MATCH: Record<string, unknown> = {
  sentAt: { $exists: false },
  externalReplyDetectedAt: { $exists: false },
  threadRespondedAt: { $exists: false },
};

/** Mongo: somebody has answered this message. */
export const ANSWERED_MATCH: Record<string, unknown> = {
  $or: [
    { sentAt: { $exists: true } },
    { externalReplyDetectedAt: { $exists: true } },
    { threadRespondedAt: { $exists: true } },
  ],
};

/**
 * Mongo: a company reply is owed. `company_reply` is the AI's own verdict;
 * `validation_failed` means the AI's draft was discarded and a person has to
 * write it, so it is owed too; items from before the AI recorded a verdict
 * fall back to whether it wanted to draft. Rejected items and approved-as-
 * "no reply needed" items are closed by the user.
 */
export const REPLY_OWED_MATCH: Record<string, unknown> = {
  status: { $ne: 'rejected' },
  // Only the newest customer message of a conversation can be owed a reply, and
  // not one the user has deleted from the mailbox.
  threadHead: { $ne: false },
  mailboxRemovedAt: { $exists: false },
  $and: [
    {
      $or: [
        { expectedNextAction: 'company_reply' },
        { aiStatus: 'validation_failed' },
        { expectedNextAction: { $exists: false }, aiStatus: { $exists: false }, shouldDraft: true },
      ],
    },
    { $nor: [{ status: 'approved', shouldDraft: false }] },
  ],
};

/** Mongo: still needs an answer. Spread it into a filter that has no `$and` of its own. */
export function needsResponseMatch(): Record<string, unknown> {
  return { $and: [UNANSWERED_MATCH, REPLY_OWED_MATCH] };
}

/** Mongo filter for one response-status view. */
export function responseStatusMatch(view: EmailResponseStatus): Record<string, unknown> {
  if (view === 'responded') return ANSWERED_MATCH;
  if (view === 'needs_response') return needsResponseMatch();
  return { $and: [UNANSWERED_MATCH, { $nor: [REPLY_OWED_MATCH] }] };
}

/**
 * Mongo: nobody has answered this message and one was owed — including the
 * older messages of a conversation (see `threadHead`). Used to mark a whole
 * conversation answered, never to count what is waiting.
 */
export function unansweredOwedMatch(): Record<string, unknown> {
  const { threadHead: _head, ...owed } = REPLY_OWED_MATCH;
  return { $and: [UNANSWERED_MATCH, owed] };
}

/** Mongo: one row per conversation — its newest customer message. */
export const THREAD_HEAD_MATCH: Record<string, unknown> = { threadHead: { $ne: false } };

function isReplyOwed(item: ResponseStateFields): boolean {
  if (item.status === 'rejected') return false;
  if (item.threadHead === false || item.mailboxRemovedAt) return false;
  // Strictly `false`, mirroring the Mongo `shouldDraft: false` in REPLY_OWED_MATCH.
  if (item.status === 'approved' && item.shouldDraft === false) return false;
  return (
    item.expectedNextAction === 'company_reply' ||
    item.aiStatus === 'validation_failed' ||
    (item.expectedNextAction === undefined && item.aiStatus === undefined && item.shouldDraft === true)
  );
}

export function deriveResponseStatus(item: ResponseStateFields): EmailResponseStatus {
  if (item.sentAt || item.externalReplyDetectedAt || item.threadRespondedAt) return 'responded';
  return isReplyOwed(item) ? 'needs_response' : 'resolved';
}

/** When and how it was answered, for display. */
export function deriveRespondedInfo(item: ResponseStateFields): { respondedAt?: Date; respondedVia?: EmailRespondedVia } {
  if (item.sentAt) return { respondedAt: item.sentAt, respondedVia: 'app' };
  if (item.externalReplyDetectedAt) return { respondedAt: item.externalReplyDetectedAt, respondedVia: 'outlook' };
  if (item.threadRespondedAt) return { respondedAt: item.threadRespondedAt, respondedVia: 'thread' };
  return {};
}

/** The single category of a conversation's newest message (see EmailCategory). */
export function deriveCategory(item: ResponseStateFields, now: Date = new Date()): EmailCategory {
  const status = deriveResponseStatus(item);
  if (status === 'needs_response') return item.urgency === 'urgent' || item.priority === 'urgent' ? 'urgent' : 'needs_response';
  if (status === 'responded') {
    if (!item.replyAwaitsCustomer) return 'responded';
    const respondedAt = deriveRespondedInfo(item).respondedAt;
    const waitedMs = respondedAt ? now.getTime() - new Date(respondedAt).getTime() : 0;
    return waitedMs >= FOLLOW_UP_AFTER_DAYS * 24 * 60 * 60 * 1000 ? 'follow_up_required' : 'waiting_for_customer';
  }
  const closedByPerson = item.status === 'rejected' || (item.status === 'approved' && item.shouldDraft === false) || !!item.mailboxRemovedAt;
  return closedByPerson ? 'completed' : 'informational';
}
