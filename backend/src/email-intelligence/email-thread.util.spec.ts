import { deriveCategory, deriveResponseStatus } from './email-response-state';
import { isForward, normalizeMessageId, normalizeSubject, OutboundMessage, replyAwaitsCustomer, ReplyIndex } from './email-thread.util';

const at = (iso: string) => new Date(iso);
const OWN = ['sam@fullypromoted.in', 'sam.alias@fullypromoted.in'];
const question = {
  receivedAt: at('2026-10-01T10:00:00Z'),
  conversationId: 'conv-1',
  internetMessageId: '<q1@customer.com>',
  fromAddress: 'Priya@Customer.com',
  subject: 'Pricing for polo shirts',
};
const sentTo = (to: string[], sentAt: string, extra: Partial<OutboundMessage> = {}): OutboundMessage => ({
  sentAt: at(sentAt),
  recipients: to,
  subject: 'RE: Pricing for polo shirts',
  ...extra,
});

describe('subject and id normalisation', () => {
  it('removes reply/forward markers in any language, however many there are', () => {
    expect(normalizeSubject('RE: Re: FW: Pricing  for polo shirts ')).toBe('pricing for polo shirts');
    expect(normalizeSubject('AW: WG: Angebot')).toBe('angebot');
    expect(normalizeSubject('SV: Tilbud')).toBe('tilbud');
    expect(normalizeSubject('RE[2]: Order 42')).toBe('order 42');
    expect(normalizeSubject('回复：报价')).toBe('报价');
  });

  it('leaves words that merely start like a marker alone', () => {
    expect(normalizeSubject('Regarding your order')).toBe('regarding your order');
    expect(normalizeSubject('Free samples')).toBe('free samples');
  });

  it('tells a forward from a reply by the outermost marker', () => {
    expect(isForward('FW: RE: Pricing')).toBe(true);
    expect(isForward('RE: FW: Pricing')).toBe(false);
    expect(isForward('Pricing')).toBe(false);
  });

  it('compares Message-IDs without brackets or case', () => {
    expect(normalizeMessageId(' <ABC@Mail.Example.com> ')).toBe('abc@mail.example.com');
  });
});

describe('ReplyIndex — which sent message answers a received one', () => {
  it('finds a reply in the same conversation sent after the question', () => {
    const index = new ReplyIndex([sentTo(['priya@customer.com'], '2026-10-01T10:15:00Z', { conversationId: 'conv-1' })], OWN);
    expect(index.findReply(question)).toMatchObject({ via: 'conversation', at: at('2026-10-01T10:15:00Z') });
  });

  it('does not count something we sent BEFORE the question', () => {
    const index = new ReplyIndex([sentTo(['priya@customer.com'], '2026-10-01T09:00:00Z', { conversationId: 'conv-1' })], OWN);
    expect(index.findReply(question)).toBeNull();
  });

  it('finds a reply by its In-Reply-To header even when Outlook filed it under another conversation and the subject changed', () => {
    const index = new ReplyIndex(
      [sentTo(['priya@customer.com'], '2026-10-01T11:00:00Z', { conversationId: 'conv-OTHER', subject: 'Your quotation', inReplyTo: '<Q1@customer.com>' })],
      OWN,
    );
    expect(index.findReply(question)).toMatchObject({ via: 'reference' });
  });

  it('finds a reply through the References chain', () => {
    const index = new ReplyIndex([sentTo(['priya@customer.com'], '2026-10-01T11:00:00Z', { references: ['<older@x>', '<q1@customer.com>'] })], OWN);
    expect(index.findReply(question)).toMatchObject({ via: 'reference' });
  });

  it('finds a reply written as a brand-new email to the customer with the same subject', () => {
    const index = new ReplyIndex(
      [sentTo(['priya@customer.com'], '2026-10-02T08:00:00Z', { conversationId: 'conv-NEW', subject: 'Pricing for polo shirts' })],
      OWN,
    );
    expect(index.findReply(question)).toMatchObject({ via: 'recipient_subject' });
  });

  it('an unrelated email does not answer it: another customer, or the same customer about something else', () => {
    const index = new ReplyIndex(
      [
        sentTo(['someone@else.com'], '2026-10-01T11:00:00Z', { conversationId: 'conv-9', subject: 'RE: Pricing for polo shirts' }),
        sentTo(['priya@customer.com'], '2026-10-01T11:30:00Z', { conversationId: 'conv-8', subject: 'Invoice 1042' }),
      ],
      OWN,
    );
    expect(index.findReply(question)).toBeNull();
  });

  it('forwarding the customer email to a colleague is not a reply to the customer', () => {
    const index = new ReplyIndex(
      [
        sentTo(['manager@fullypromoted.in'], '2026-10-01T10:05:00Z', { conversationId: 'conv-1', subject: 'FW: Pricing for polo shirts' }),
        sentTo(['ops@fullypromoted.in'], '2026-10-01T10:06:00Z', { conversationId: 'conv-1', subject: 'RE: Pricing for polo shirts' }),
      ],
      OWN,
    );
    expect(index.findReply(question)).toBeNull();
  });

  it('a reply to a different address of the customer in the same conversation still counts', () => {
    const index = new ReplyIndex([sentTo(['accounts@customer.com'], '2026-10-01T10:20:00Z', { conversationId: 'conv-1' })], OWN);
    expect(index.findReply(question)).toMatchObject({ via: 'conversation' });
  });

  it('reports the first reply as the answer time and the newest one as what the customer last heard', () => {
    const index = new ReplyIndex(
      [
        sentTo(['priya@customer.com'], '2026-10-01T10:15:00Z', { conversationId: 'conv-1', preview: 'Will send today.' }),
        sentTo(['priya@customer.com'], '2026-10-01T16:00:00Z', { conversationId: 'conv-1', preview: 'Attached. Can you confirm the quantities?' }),
      ],
      OWN,
    );
    const match = index.findReply(question)!;
    expect(match.at).toEqual(at('2026-10-01T10:15:00Z'));
    expect(match.latest.preview).toContain('Can you confirm');
  });

  it('a same-subject email long after the question is not assumed to be its reply', () => {
    const index = new ReplyIndex([sentTo(['priya@customer.com'], '2026-12-15T08:00:00Z', { subject: 'Pricing for polo shirts' })], OWN);
    expect(index.findReply(question)).toBeNull();
  });
});

describe('replyAwaitsCustomer', () => {
  it('is true when our reply asks the customer for something', () => {
    expect(replyAwaitsCustomer('Could you share the logo file?')).toBe(true);
    expect(replyAwaitsCustomer('Please confirm the delivery address.')).toBe(true);
    expect(replyAwaitsCustomer('Let me know which colour you prefer')).toBe(true);
  });
  it('is false for a reply that simply answers', () => {
    expect(replyAwaitsCustomer('Sure, I will send the pricing today.')).toBe(false);
    expect(replyAwaitsCustomer('')).toBe(false);
  });
});

describe('one category per conversation', () => {
  const owed = { status: 'pending', expectedNextAction: 'company_reply', shouldDraft: true };
  const now = at('2026-10-10T00:00:00Z');

  it('needs a reply — urgent when the email is', () => {
    expect(deriveCategory(owed, now)).toBe('needs_response');
    expect(deriveCategory({ ...owed, urgency: 'urgent' }, now)).toBe('urgent');
  });

  it('replied: responded, waiting for the customer, then follow-up required as days pass', () => {
    expect(deriveCategory({ ...owed, externalReplyDetectedAt: at('2026-10-09T00:00:00Z') }, now)).toBe('responded');
    expect(deriveCategory({ ...owed, externalReplyDetectedAt: at('2026-10-09T00:00:00Z'), replyAwaitsCustomer: true }, now)).toBe('waiting_for_customer');
    expect(deriveCategory({ ...owed, externalReplyDetectedAt: at('2026-10-05T00:00:00Z'), replyAwaitsCustomer: true }, now)).toBe('follow_up_required');
  });

  it('nothing owed: informational, or completed when a person closed it', () => {
    expect(deriveCategory({ status: 'pending', expectedNextAction: 'no_action_required', shouldDraft: false }, now)).toBe('informational');
    expect(deriveCategory({ ...owed, status: 'rejected' }, now)).toBe('completed');
    expect(deriveCategory({ ...owed, mailboxRemovedAt: at('2026-10-09T00:00:00Z') }, now)).toBe('completed');
  });

  it('an older message of a conversation is not itself waiting; a deleted one neither', () => {
    expect(deriveResponseStatus({ ...owed, threadHead: false })).toBe('resolved');
    expect(deriveResponseStatus({ ...owed, mailboxRemovedAt: now })).toBe('resolved');
    expect(deriveResponseStatus({ ...owed, threadHead: true })).toBe('needs_response');
  });
});
