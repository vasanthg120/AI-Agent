// How the AI Email Inbox decides that a message we sent answers a message we
// received. Pure functions over plain data — no database, no Outlook — so the
// rules can be read and tested on their own.
//
// A reply is recognised by, in order of trust:
//   1. reference    — its In-Reply-To / References headers name the customer's
//                     message. Exact, and survives a changed subject or Outlook
//                     splitting the thread.
//   2. conversation — Outlook filed both under one conversation and ours is
//                     the later one, unless it is plainly not addressed to the
//                     customer (a forward to a colleague).
//   3. recipient + subject — a later message to the customer's address with
//                     the same subject once "Re:" / "Fwd:" style prefixes (in
//                     any language) are removed. Catches a reply written as a
//                     new email.
// Anything else — a message to someone else, or to the same customer about
// something else — answers nothing.

export const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.co.in',
  'yahoo.co.uk',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'rediffmail.com',
  'zoho.com',
]);

// Reply / forward markers mail clients put in front of a subject, across the
// languages Outlook ships in. Matched only as a prefix followed by a colon.
const REPLY_PREFIXES = ['re', 'r', 'aw', 'antw', 'sv', 'vs', 'res', 'odp', 'ynt', 'ref', 'atb', '回复', '答复', '回覆', '返信'];
const FORWARD_PREFIXES = ['fw', 'fwd', 'wg', 'tr', 'enc', 'rv', 'vl', 'vb', 'doorst', 'i', 'pd', 'ilt', '转发', '轉寄', '転送'];
const prefixPattern = (prefixes: string[]) => new RegExp(`^\\s*(?:${prefixes.join('|')})(?:\\[\\d+\\])?\\s*[:：]\\s*`, 'i');
const ANY_PREFIX = prefixPattern([...REPLY_PREFIXES, ...FORWARD_PREFIXES]);
const FORWARD_PREFIX = prefixPattern(FORWARD_PREFIXES);
const REPLY_PREFIX = prefixPattern(REPLY_PREFIXES);

/** The subject with every leading reply/forward marker removed, lower-cased, spaces collapsed. */
export function normalizeSubject(subject: string | undefined | null): string {
  let text = (subject ?? '').trim();
  for (let i = 0; i < 12 && ANY_PREFIX.test(text); i += 1) text = text.replace(ANY_PREFIX, '');
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** True when the outermost marker on the subject is a forward ("FW: RE: …"), not a reply. */
export function isForward(subject: string | undefined | null): boolean {
  const text = (subject ?? '').trim();
  return FORWARD_PREFIX.test(text) && !REPLY_PREFIX.test(text);
}

export function normalizeAddress(address: string | undefined | null): string {
  return (address ?? '').trim().toLowerCase();
}

export function domainOf(address: string | undefined | null): string {
  const normalized = normalizeAddress(address);
  const at = normalized.lastIndexOf('@');
  return at < 0 ? '' : normalized.slice(at + 1);
}

/** An RFC Message-ID in one comparable form: no angle brackets, lower-cased. */
export function normalizeMessageId(id: string | undefined | null): string {
  return (id ?? '')
    .trim()
    .replace(/^<+|>+$/g, '')
    .toLowerCase();
}

export interface OutboundMessage {
  id?: string;
  sentAt: Date;
  conversationId?: string;
  internetMessageId?: string;
  inReplyTo?: string;
  references?: string[];
  /** To and Cc together. */
  recipients: string[];
  subject?: string;
  preview?: string;
}

export interface InboundMessage {
  receivedAt: Date;
  conversationId?: string;
  internetMessageId?: string;
  fromAddress: string;
  subject?: string;
}

export type ReplyMatchVia = 'reference' | 'conversation' | 'recipient_subject';

export interface ReplyMatch {
  /** When the first answering message was sent. */
  at: Date;
  via: ReplyMatchVia;
  /** The first answering message. */
  message: OutboundMessage;
  /** The newest answering message — what the customer last heard from us. */
  latest: OutboundMessage;
}

// A reply written as a new email is only trusted this long after the customer's message.
const RECIPIENT_SUBJECT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// Mail servers disagree by a few seconds; a referenced reply is never "before" its question.
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MIN_SUBJECT_LENGTH = 3;

/**
 * Looks up, for a received message, the messages we sent that answer it.
 * `ownAddresses` are every address of the mailbox (and so of "us"): a message
 * sent only to ourselves or to colleagues on our own domain is not an answer
 * to an outside sender.
 */
export class ReplyIndex {
  private readonly byConversation = new Map<string, OutboundMessage[]>();
  private readonly byReference = new Map<string, OutboundMessage[]>();
  private readonly byRecipientSubject = new Map<string, OutboundMessage[]>();
  private readonly ownAddresses: Set<string>;
  private readonly ownDomains: Set<string>;

  constructor(outbound: OutboundMessage[], ownAddresses: string[] = []) {
    this.ownAddresses = new Set(ownAddresses.map(normalizeAddress).filter(Boolean));
    this.ownDomains = new Set([...this.ownAddresses].map(domainOf).filter((d) => d && !PUBLIC_MAIL_DOMAINS.has(d)));
    const push = (map: Map<string, OutboundMessage[]>, key: string, message: OutboundMessage) => {
      const list = map.get(key);
      if (list) list.push(message);
      else map.set(key, [message]);
    };
    for (const message of [...outbound].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())) {
      if (message.conversationId) push(this.byConversation, message.conversationId, message);
      const referenced = new Set([message.inReplyTo, ...(message.references ?? [])].map(normalizeMessageId).filter(Boolean));
      for (const id of referenced) push(this.byReference, id, message);
      const subject = normalizeSubject(message.subject);
      if (subject.length >= MIN_SUBJECT_LENGTH) {
        for (const recipient of new Set(message.recipients.map(normalizeAddress).filter(Boolean)))
          push(this.byRecipientSubject, `${recipient}\n${subject}`, message);
      }
    }
  }

  private isInternal(address: string): boolean {
    return this.ownAddresses.has(address) || this.ownDomains.has(domainOf(address));
  }

  /** A message in the customer's conversation that plainly was not written to them. */
  private notForSender(message: OutboundMessage, sender: string): boolean {
    const recipients = message.recipients.map(normalizeAddress).filter(Boolean);
    if (recipients.length === 0 || recipients.includes(sender)) return false;
    // Same conversation, different recipients: a forward, or a note to colleagues only.
    return isForward(message.subject) || recipients.every((r) => this.isInternal(r));
  }

  findReply(inbound: InboundMessage): ReplyMatch | null {
    const received = inbound.receivedAt.getTime();
    const sender = normalizeAddress(inbound.fromAddress);
    const found: { message: OutboundMessage; via: ReplyMatchVia }[] = [];

    const messageId = normalizeMessageId(inbound.internetMessageId);
    if (messageId) {
      for (const message of this.byReference.get(messageId) ?? []) {
        if (message.sentAt.getTime() >= received - CLOCK_SKEW_MS && !this.notForSender(message, sender)) found.push({ message, via: 'reference' });
      }
    }
    if (inbound.conversationId) {
      for (const message of this.byConversation.get(inbound.conversationId) ?? []) {
        if (message.sentAt.getTime() > received && !this.notForSender(message, sender)) found.push({ message, via: 'conversation' });
      }
    }
    const subject = normalizeSubject(inbound.subject);
    if (sender && subject.length >= MIN_SUBJECT_LENGTH) {
      for (const message of this.byRecipientSubject.get(`${sender}\n${subject}`) ?? []) {
        const sent = message.sentAt.getTime();
        if (sent > received && sent - received <= RECIPIENT_SUBJECT_WINDOW_MS) found.push({ message, via: 'recipient_subject' });
      }
    }
    if (found.length === 0) return null;

    const rank: Record<ReplyMatchVia, number> = { reference: 0, conversation: 1, recipient_subject: 2 };
    const first = found.reduce((a, b) => (b.message.sentAt.getTime() < a.message.sentAt.getTime() ? b : a));
    const latest = found.reduce((a, b) => (b.message.sentAt.getTime() > a.message.sentAt.getTime() ? b : a));
    // Report the strongest evidence there is for the answer, not merely the first one found.
    const via = found.reduce((a, b) => (rank[b.via] < rank[a.via] ? b : a)).via;
    return { at: first.message.sentAt, via, message: first.message, latest: latest.message };
  }
}

// "Is our reply waiting on the customer?" — it asks them something, or asks
// them to do something. Read from the reply's own words, no AI call.
const ASKS_CUSTOMER =
  /\?|\b(let (me|us) know|please (confirm|advise|share|send|provide|let|reply|review|check|approve|sign)|kindly (confirm|advise|share|send|provide|review|approve)|could you|can you|would you|awaiting your|await your|waiting (for|on) your|look(ing)? forward to (your|hearing)|get back to (me|us)|once you (confirm|approve|share|send))\b/i;

export function replyAwaitsCustomer(text: string | undefined | null): boolean {
  return ASKS_CUSTOMER.test(text ?? '');
}
