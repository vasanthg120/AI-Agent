// What happened with a customer, as timeline entries — and the two things the
// mail itself says about the relationship: how quickly they answer us, and how
// quickly we answer them. Pure: no database, no CRM, no AI.

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface TimelineEvent {
  at: Date;
  // The last five are the team's own: what it wrote, set itself to do, attached, the statuses it set by hand, and the jobs it made.
  kind:
    | 'contact'
    | 'enquiry'
    | 'deal'
    | 'quotation'
    | 'order'
    | 'payment'
    | 'email_received'
    | 'email_sent'
    | 'follow_up'
    | 'comment'
    | 'task'
    | 'file'
    | 'status'
    | 'job';
  title: string;
  detail?: string;
  amount?: number;
  /** Something is still owed on this event (an unanswered email, an open quotation, a follow-up that is due). */
  attention?: boolean;
}

export interface EmailRecord {
  id: string;
  direction: 'received' | 'sent';
  at: Date;
  subject: string;
  conversationId?: string;
  /** For a received email: nobody has replied and a reply is owed. */
  needsReply?: boolean;
  /** For a received email: when it was answered. */
  answeredAt?: Date;
}

export interface FollowUpRecord {
  title: string;
  dueDate: Date;
  status: 'pending' | 'done' | 'dismissed';
}

const time = (date?: Date) => date?.getTime() ?? 0;
const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** An amount as a person reads it: rupees grouped the Indian way, no decimals on whole amounts. */
export function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString('en-IN')}`;
  }
}

/** How quickly each side answers the other: the customer's typical days to come back to us, and our typical hours to answer them. */
export function emailReplySpeeds(emails: EmailRecord[]): { customerRepliesInDays: number | null; weReplyInHours: number | null } {
  const received = emails.filter((e) => e.direction === 'received');
  const sent = emails.filter((e) => e.direction === 'sent');
  const weReplyInHours = median(received.filter((e) => e.answeredAt).map((e) => (e.answeredAt!.getTime() - e.at.getTime()) / HOUR_MS));
  // How long the customer takes to come back: each email of ours, to their next one in the same conversation.
  const customerReplyDays: number[] = [];
  for (const ours of sent) {
    if (!ours.conversationId) continue;
    const next = received
      .filter((r) => r.conversationId === ours.conversationId && r.at.getTime() > ours.at.getTime())
      .sort((a, b) => time(a.at) - time(b.at))[0];
    if (next) customerReplyDays.push((next.at.getTime() - ours.at.getTime()) / DAY_MS);
  }
  return { customerRepliesInDays: median(customerReplyDays), weReplyInHours };
}

/** Emails as timeline entries: one per conversation per day and direction — a ten-message thread is not ten timeline rows. */
export function emailTimelineEvents(emails: EmailRecord[]): TimelineEvent[] {
  const seen = new Map<string, TimelineEvent & { count: number }>();
  for (const e of [...emails].sort((a, b) => time(b.at) - time(a.at))) {
    const key = `${e.direction}|${e.conversationId ?? e.id}|${e.at.toISOString().slice(0, 10)}`;
    const existing = seen.get(key);
    if (existing) {
      existing.count += 1;
      existing.detail = `${existing.count} messages · ${e.subject}`;
      existing.attention = existing.attention || !!e.needsReply;
      continue;
    }
    seen.set(key, {
      at: e.at,
      kind: e.direction === 'received' ? 'email_received' : 'email_sent',
      title: e.direction === 'received' ? 'Email from the customer' : 'Email sent to the customer',
      detail: e.subject,
      attention: !!e.needsReply,
      count: 1,
    });
  }
  return [...seen.values()].map(({ count: _count, ...event }) => event);
}

/** Follow-up reminders set on the customer's emails, as timeline entries. */
export function followUpTimelineEvents(followUps: FollowUpRecord[], now: Date): TimelineEvent[] {
  return followUps.map((f) => ({
    at: f.dueDate,
    kind: 'follow_up',
    title: f.status === 'done' ? 'Follow-up done' : f.status === 'dismissed' ? 'Follow-up dismissed' : 'Follow-up due',
    detail: f.title,
    attention: f.status === 'pending' && f.dueDate.getTime() <= now.getTime(),
  }));
}
