// The AI Email Inbox's boxes. Every email is in exactly one, named by what it
// needs from the person — not by the AI's internal type labels:
//
//   new_enquiries     someone asking to buy, still waiting for our answer
//   to_reply          any other email still waiting for our answer
//   awaiting_customer we answered and asked them something back
//   replied           we answered, nothing more expected
//   no_reply          business mail that needs no answer (or a person closed it)
//   junk              receipts, notifications, newsletters, internal mail
//
// Anything still owed a reply is always in one of the first two, whatever type
// the AI gave it — junk is only ever mail that owes nothing. `inboxBoxMatch`
// (Mongo, for lists and counts) and `inboxBoxOf` (one document) are the same
// rules; email-inbox-boxes.spec.ts pins them together.

import { deriveResponseStatus, needsResponseMatch, responseStatusMatch, ResponseStateFields } from './email-response-state';

// The vendor/customer/enquiry-type intents a salesperson actually acts on, vs.
// payment/purchase_order/refund/internal/spam/other noise. Deliberately an
// allow-list, not an exclude-list, so a new intent value added later defaults
// to "not business mail" until deliberately added here. Same list as the
// frontend's RELEVANT_EMAIL_INTENTS.
export const RELEVANT_EMAIL_INTENTS = [
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

export const INBOX_BOXES = ['new_enquiries', 'to_reply', 'awaiting_customer', 'replied', 'no_reply', 'junk'] as const;
export type InboxBox = (typeof INBOX_BOXES)[number];

/** Someone new asking to buy: what a salesperson answers first. */
export const ENQUIRY_INTENTS = ['new_enquiry', 'quotation_request'];

// Business mail: a type a business answers, or mail the AI hasn't read yet (it may be a customer).
const BUSINESS_MATCH: Record<string, unknown> = { $or: [{ intent: { $in: RELEVANT_EMAIL_INTENTS } }, { analysisState: 'pending' }] };

/** Mongo: the emails in one box. */
export function inboxBoxMatch(box: InboxBox): Record<string, unknown> {
  switch (box) {
    case 'new_enquiries':
      return { $and: [needsResponseMatch(), { intent: { $in: ENQUIRY_INTENTS } }] };
    case 'to_reply':
      return { $and: [needsResponseMatch(), { intent: { $nin: ENQUIRY_INTENTS } }] };
    case 'awaiting_customer':
      return { $and: [responseStatusMatch('responded'), BUSINESS_MATCH, { replyAwaitsCustomer: true }] };
    case 'replied':
      return { $and: [responseStatusMatch('responded'), BUSINESS_MATCH, { replyAwaitsCustomer: { $ne: true } }] };
    case 'no_reply':
      return { $and: [responseStatusMatch('resolved'), BUSINESS_MATCH] };
    case 'junk':
      return { $and: [{ $nor: [needsResponseMatch()] }, { $nor: [BUSINESS_MATCH] }] };
  }
}

/** The box of one email — the same rules as inboxBoxMatch. */
export function inboxBoxOf(item: ResponseStateFields & { intent?: string; analysisState?: string }): InboxBox {
  const status = deriveResponseStatus(item);
  if (status === 'needs_response') return ENQUIRY_INTENTS.includes(item.intent ?? '') ? 'new_enquiries' : 'to_reply';
  const business = RELEVANT_EMAIL_INTENTS.includes(item.intent ?? '') || item.analysisState === 'pending';
  if (!business) return 'junk';
  if (status === 'responded') return item.replyAwaitsCustomer ? 'awaiting_customer' : 'replied';
  return 'no_reply';
}
