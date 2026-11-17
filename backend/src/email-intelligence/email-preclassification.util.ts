// Deterministic pre-filter, run before any LLM call. Catches the classic
// "never worth asking Claude" categories — bounce/delivery-failure notices,
// delivery/read receipts, automated out-of-office replies, no-reply robots,
// marketing/newsletter mail and HaiVE's own reports — via cheap, conservative
// pattern matching. Only fires on unambiguous signals (bounce-sentinel and
// no-reply addresses, receipt/auto-reply subject phrasing, a literal
// "unsubscribe" mention); never a guess dressed up as a rule. Cuts LLM
// cost/latency, keeps automated mail out of "Needs Response" even when the AI
// can't read it (no credits), and removes an entire class of hallucination
// risk for mail that was never going to need a real reply in the first place.
//
// Deliberately does NOT attempt "invoice attached -> vendor" style detection
// — the fetched email shape (see outlook.py's _map_message) carries no
// attachment/header data to detect that from, and guessing would violate
// this codebase's "never invent a signal you don't actually have" rule.

export type PreFilterRule = 'system' | 'bounce' | 'receipt' | 'meeting_response' | 'auto_reply' | 'marketing' | 'no_reply';

export interface DeterministicPreFilterMatch {
  ruleName: PreFilterRule;
  reason: string;
}

export interface PreFilterOptions {
  /** HaiVE's own sending addresses (MAIL_FROM / SMTP_USER): its reports and alerts are never customer mail. */
  systemSenders?: string[];
}

/** Rules certain enough to override what the AI said; the others only decide mail the AI hasn't read. */
export const UNMISTAKABLE_RULES: ReadonlySet<PreFilterRule> = new Set(['system', 'bounce', 'receipt', 'meeting_response', 'auto_reply']);

const BOUNCE_SENDER_PATTERN = /^(postmaster|mailer-daemon|mail-daemon)@/i;
// Exchange's own system mailbox, which sends delivery and relay reports
// ("MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@yourdomain").
const EXCHANGE_SYSTEM_SENDER = /^microsoftexchange[0-9a-f]{16,}@/i;
const BOUNCE_SUBJECT_PATTERN =
  /(undeliverable|delivery (status notification|has failed)|returned mail|mail delivery failed|delivery failure)/i;
// Outlook's delivery / read receipts: "Delivered: …", "Relayed: …", "Read: …".
const RECEIPT_SUBJECT_PATTERN = /^(delivered|relayed|read|not read|delivery delayed|expanded)\s*:/i;
// Outlook's answers to a meeting invitation. Not "New Time Proposed:" — that one asks for something.
const MEETING_RESPONSE_SUBJECT_PATTERN = /^(accepted|tentatively accepted|declined)\s*:/i;
const AUTO_REPLY_SUBJECT_PATTERN = /^(automatic reply|auto-?reply)\s*:|out of office/i;
const UNSUBSCRIBE_PATTERN = /unsubscribe/i;
// Robots nobody is expected to answer: no-reply boxes ("no-reply@porter.in",
// "billing-noreply@…") and notification senders ("notifications@…",
// "microsoftcopilotupdates@microsoft.com"). Not "marketing@" / "promo@": a
// customer's marketing team ordering merchandise is exactly who writes in.
const NO_REPLY_LOCAL_PART = /no-?reply|do-?not-?reply/i;
const ROBOT_LOCAL_PART = /^(notifications?|alerts?|news(letters?)?|updates?|mailer|bounces?)([._+-]|$)|(updates|newsletters?|notifications?)$/i;
// Website and enquiry forms often send from a no-reply address with the
// customer's details inside — those are leads, so the no-reply rule leaves
// them to the AI.
const ENQUIRY_PATTERN = /\b(enquir\w*|inquir\w*|quot(e|es|ation|ations)|rfq|contact form|form submission|new (lead|submission|message)|call ?back|booking)\b/i;

/** The bare address of "Name <a@b.com>" or "a@b.com", lower-cased. */
export function bareAddress(value: string): string {
  const angled = /<([^>]+)>/.exec(value);
  return (angled ? angled[1] : value).trim().toLowerCase();
}

export function classifyEmailDeterministically(
  email: { from: string; subject: string; preview: string },
  options: PreFilterOptions = {},
): DeterministicPreFilterMatch | null {
  const from = bareAddress(email.from);
  const localPart = from.split('@')[0] ?? '';
  const subject = email.subject.trim();
  const preview = email.preview.trim();

  if (from && (options.systemSenders ?? []).some((sender) => bareAddress(sender) === from)) {
    return { ruleName: 'system', reason: 'HaiVE’s own notification or report — no reply needed.' };
  }
  if (BOUNCE_SENDER_PATTERN.test(from) || BOUNCE_SUBJECT_PATTERN.test(subject)) {
    return { ruleName: 'bounce', reason: 'Automated delivery failure / bounce notice — no action needed.' };
  }
  if (RECEIPT_SUBJECT_PATTERN.test(subject) || EXCHANGE_SYSTEM_SENDER.test(from)) {
    return { ruleName: 'receipt', reason: 'Automated delivery or read receipt — no action needed.' };
  }
  if (MEETING_RESPONSE_SUBJECT_PATTERN.test(subject)) {
    return { ruleName: 'meeting_response', reason: 'An answer to a meeting invitation (accepted / declined) — no reply needed.' };
  }
  if (AUTO_REPLY_SUBJECT_PATTERN.test(subject)) {
    return { ruleName: 'auto_reply', reason: 'Automated out-of-office / auto-reply message — no action needed.' };
  }
  if (UNSUBSCRIBE_PATTERN.test(subject) || UNSUBSCRIBE_PATTERN.test(preview)) {
    return { ruleName: 'marketing', reason: 'Marketing/newsletter email (unsubscribe footer detected) — no action needed.' };
  }
  if ((NO_REPLY_LOCAL_PART.test(localPart) || ROBOT_LOCAL_PART.test(localPart)) && !ENQUIRY_PATTERN.test(`${subject} ${preview}`)) {
    return { ruleName: 'no_reply', reason: 'Sent by an automated no-reply or notification address — no reply expected.' };
  }
  return null;
}
