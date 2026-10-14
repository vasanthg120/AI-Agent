import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model, Types } from 'mongoose';
import { of, throwError } from 'rxjs';
import { EmailIntelligenceSyncService } from './email-intelligence-sync.service';
import { EmailIntelligenceService } from './email-intelligence.service';
import { deriveResponseStatus } from './email-response-state';
import { EmailIntelligenceItem, EmailIntelligenceItemDocument, EmailIntelligenceItemSchema } from './schemas/email-intelligence-item.schema';

// Replying from the AI Email Inbox, against a real Mongo and the real services
// (only the python-agent calls and the wallet are stubbed):
//   - "Approve & send" is one step, for the AI's draft, an edited one, or a
//     reply written by hand for an email the AI drafted nothing for;
//   - mail that is waiting without a draft gets one from the AI — on a click,
//     or by itself for a mailbox whose owner switched auto-draft on;
//   - the owner's settings are theirs and are remembered.
const PREFIX = `jest-inbox-replies-${Date.now()}`;
const DAY = 86_400_000;

describe('AI Email Inbox — replies and drafts (real Mongo)', () => {
  let connection: Connection;
  let items: Model<EmailIntelligenceItemDocument>;
  let service: EmailIntelligenceService;
  let sync: EmailIntelligenceSyncService;
  let httpPost: jest.Mock;
  let reservations: { reserve: jest.Mock; settle: jest.Mock; release: jest.Mock; resolveTenantKey: (org: string) => string };
  let seq = 0;
  let userId: string;
  let orgId: string;

  // What the AI answers for an email: a drafted reply, or "no reply needed".
  const aiDraft = (text: string) => ({
    intent: 'quotation_request',
    priority: 'high',
    urgency: 'high',
    sentiment: 'neutral',
    recommendedAction: 'Reply with the quotation.',
    shouldDraft: true,
    draftWrittenFromOurPerspective: true,
    draftReply: text,
    draftReasoning: 'The customer asked for a price.',
  });
  const aiNoReply = {
    intent: 'other',
    priority: 'low',
    urgency: 'low',
    sentiment: 'neutral',
    recommendedAction: 'A newsletter — nothing to answer.',
    shouldDraft: false,
    draftWrittenFromOurPerspective: false,
  };

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(uri), MongooseModule.forFeature([{ name: EmailIntelligenceItem.name, schema: EmailIntelligenceItemSchema }])],
    }).compile();
    items = moduleRef.get(getModelToken(EmailIntelligenceItem.name));
    connection = items.db;
  });

  beforeEach(async () => {
    seq += 1;
    // A real user document: the settings live on it.
    const user = await connection
      .collection('users')
      .insertOne({ email: `${PREFIX}-${seq}@example.test`, organizationId: `${PREFIX}-org-${seq}`, roles: ['owner'], jestRun: PREFIX });
    userId = user.insertedId.toString();
    orgId = `${PREFIX}-org-${seq}`;
    httpPost = jest.fn(() => of({ data: {} }));
    reservations = {
      reserve: jest.fn(async () => undefined),
      settle: jest.fn(async () => undefined),
      release: jest.fn(async () => undefined),
      resolveTenantKey: (org) => org,
    };
    const users = { findById: async (id: string) => (id === userId ? { organizationId: orgId, name: 'Vasanth' } : null), findAll: async () => [] };
    service = new EmailIntelligenceService(
      items,
      {} as never, // followUpModel
      { create: jest.fn(async () => undefined) } as never, // notifications
      {} as never, // customerActivity
      {} as never, // quotes
      users as never,
      { post: httpPost, get: jest.fn() } as never,
      { sign: () => 'token' } as never,
      { get: () => undefined } as never,
      { recordFirstResponse: jest.fn(async () => undefined), createOrUpdateRecordForItem: jest.fn(async () => undefined) } as never, // email SLA
      reservations as never,
    );
    const noCrm = {
      exactEmails: new Set(),
      domains: new Set(),
      businessNamesForFuzzy: [],
      emailToGroupKey: new Map(),
      domainToGroupKey: new Map(),
      groups: new Map(),
    };
    sync = new EmailIntelligenceSyncService(
      {} as never, // connections
      {} as never, // sync jobs
      {} as never, // agent executions
      users as never,
      { gatherCorrelationContext: async () => noCrm } as never,
      service,
      {} as never, // history
      { threadContext: async () => undefined, ownAddresses: async () => ['me@example.com'] } as never,
      { post: httpPost, get: jest.fn() } as never,
      { sign: () => 'token' } as never,
      { get: () => undefined } as never,
    );
  });

  afterAll(async () => {
    await items.deleteMany({ organizationId: { $regex: `^${PREFIX}` } });
    await connection.collection('users').deleteMany({ jestRun: PREFIX });
    await connection.close();
  });

  // An email waiting for a reply. By default: drafted by the AI.
  async function waiting(overrides: Record<string, unknown> = {}) {
    return items.create({
      organizationId: orgId,
      userId,
      mailboxEmail: 'me@example.com',
      externalMessageId: `${PREFIX}-msg-${++seq}`,
      conversationId: `${PREFIX}-conv-${seq}`,
      receivedAt: new Date(Date.now() - 3 * 3_600_000),
      subject: 'Quote for 200 units',
      fromAddress: 'customer@example.com',
      toAddresses: ['me@example.com'],
      bodyPreview: 'Please send your best price for 200 units.',
      intent: 'quotation_request',
      priority: 'high',
      urgency: 'high',
      sentiment: 'neutral',
      recommendedAction: 'Reply with a quote',
      shouldDraft: true,
      draftReply: 'Hi — here is the quote.',
      expectedNextAction: 'company_reply',
      aiStatus: 'draft_ready',
      deterministicInput: { fixture: true },
      result: { fixture: true },
      ...overrides,
    });
  }
  // The way mailbox history arrives: stored and tracked, never read by the AI, nothing drafted.
  const imported = (overrides: Record<string, unknown> = {}) =>
    waiting({
      shouldDraft: false,
      draftReply: undefined,
      aiStatus: undefined,
      intent: 'other',
      priority: 'medium',
      urgency: 'medium',
      deterministicInput: { skippedLlmCall: true, reasonForSkip: 'history import' },
      ...overrides,
    });
  const sentTo = () => httpPost.mock.calls.filter((call) => String(call[0]).endsWith('/outlook/send-reply')).map((call) => call[1]);
  const fresh = async (item: { _id: unknown }) => (await items.findById(item._id))!;

  describe('Approve & send', () => {
    it('sends the AI’s draft in one step, and the email is answered', async () => {
      const item = await waiting();

      const sent = await service.reply(userId, item._id.toString(), 'Hi — here is the quote.');

      expect(sentTo()).toEqual([{ messageId: item.externalMessageId, comment: 'Hi — here is the quote.' }]);
      expect(sent).toMatchObject({ status: 'approved', finalDraftReply: 'Hi — here is the quote.', wasEdited: false, approvedBy: userId });
      expect(sent.sentAt).toBeInstanceOf(Date);
      expect(deriveResponseStatus(await fresh(item))).toBe('responded');
      // Once is once: a second press cannot send it again.
      await expect(service.reply(userId, item._id.toString(), 'Hi — here is the quote.')).rejects.toBeInstanceOf(BadRequestException);
      expect(sentTo()).toHaveLength(1);
    });

    it('sends what the person changed it to, and records that it was edited', async () => {
      const item = await waiting();
      const sent = await service.reply(userId, item._id.toString(), '  Hi — 200 units at ₹450 each, delivered in 10 days.  ');
      expect(sentTo()).toEqual([{ messageId: item.externalMessageId, comment: 'Hi — 200 units at ₹450 each, delivered in 10 days.' }]);
      expect(sent).toMatchObject({ wasEdited: true, draftReply: 'Hi — here is the quote.' });
    });

    it('sends a reply written by hand for an email the AI drafted nothing for', async () => {
      const item = await imported();
      expect(deriveResponseStatus(item)).toBe('needs_response');

      const sent = await service.reply(userId, item._id.toString(), 'Thanks for writing — the price list is attached.');

      expect(sentTo()).toEqual([{ messageId: item.externalMessageId, comment: 'Thanks for writing — the price list is attached.' }]);
      expect(sent).toMatchObject({ shouldDraft: true, status: 'approved', finalDraftReply: 'Thanks for writing — the price list is attached.' });
      expect(deriveResponseStatus(await fresh(item))).toBe('responded');
    });

    it('a failed send leaves it approved, unsent and still waiting — and it can be sent again', async () => {
      const item = await waiting();
      httpPost.mockReturnValueOnce(throwError(() => ({ response: { data: { detail: 'Outlook refused the message.' } } })));

      await expect(service.reply(userId, item._id.toString(), 'Hi — here is the quote.')).rejects.toThrow('Outlook refused the message.');
      const failed = await fresh(item);
      expect(failed).toMatchObject({ status: 'approved', sendError: 'Outlook refused the message.' });
      expect(failed.sentAt).toBeUndefined();
      expect(deriveResponseStatus(failed)).toBe('needs_response');

      const sent = await service.reply(userId, item._id.toString(), 'Hi — here is the quote.');
      expect(sent.sentAt).toBeInstanceOf(Date);
      expect(sent.sendError).toBeUndefined();
    });

    it('refuses an empty reply, and a reply to an email already answered in Outlook', async () => {
      const item = await waiting();
      await expect(service.reply(userId, item._id.toString(), '   ')).rejects.toThrow('Write the reply');
      const answered = await waiting({ externalReplyDetectedAt: new Date() });
      await expect(service.reply(userId, answered._id.toString(), 'Too late')).rejects.toThrow('already been replied to');
      expect(sentTo()).toEqual([]);
      // Somebody else's email is not there to reply to.
      await expect(service.reply(new Types.ObjectId().toString(), item._id.toString(), 'Hello')).rejects.toThrow('not found');
    });

    it('approving without sending still works both ways: a written reply is a reply, no text is "no reply needed"', async () => {
      const written = await imported();
      expect(await service.approve(userId, written._id.toString(), 'I will call you tomorrow.')).toMatchObject({
        shouldDraft: true,
        finalDraftReply: 'I will call you tomorrow.',
        status: 'approved',
      });
      expect(deriveResponseStatus(await fresh(written))).toBe('needs_response'); // approved, not sent yet

      const closed = await imported();
      await service.approve(userId, closed._id.toString());
      expect(await fresh(closed)).toMatchObject({ shouldDraft: false, status: 'approved' });
      expect(deriveResponseStatus(await fresh(closed))).toBe('resolved');
    });
  });

  describe('drafts for mail waiting without one', () => {
    it('counts and lists only what is waiting, undrafted and never read by the AI — newest first', async () => {
      const older = await imported({ receivedAt: new Date(Date.now() - 50 * DAY), subject: 'older' });
      const newer = await imported({ receivedAt: new Date(Date.now() - 2 * DAY), subject: 'newer' });
      await waiting(); // already has a draft
      await imported({ externalReplyDetectedAt: new Date() }); // answered in Outlook
      await imported({ status: 'rejected' }); // dismissed
      await waiting({ shouldDraft: false, draftReply: undefined, aiStatus: 'validation_failed', deterministicInput: { fixture: true } }); // the AI read it and wrote nothing

      expect((await service.listWithoutDraft(userId, 10)).map((i) => i.subject)).toEqual(['newer', 'older']);
      expect((await service.listWithoutDraft(userId, 10, 30)).map((i) => String(i._id))).toEqual([String(newer._id)]);
      expect(await service.draftSummary(userId)).toEqual({ waiting: 4, withDraft: 1, withoutDraft: 2, recentWithoutDraft: 1, autoDraftWindowDays: 30 });
      expect(String(older._id)).not.toBe(String(newer._id));
    });

    it('the Mail Type filter never hides waiting mail the AI has not sorted yet', async () => {
      const unsorted = await imported({ subject: 'unsorted' }); // from outside, type unknown ("other")
      const drafted = await waiting({ subject: 'drafted' }); // a quotation request, read by the AI
      await waiting({
        subject: 'newsletter',
        intent: 'other',
        shouldDraft: false,
        draftReply: undefined,
        expectedNextAction: 'no_action_required',
        aiStatus: 'no_reply_needed',
      }); // read by the AI: really "other"
      await imported({ subject: 'internal', intent: 'internal', expectedNextAction: 'no_action_required', aiStatus: 'no_reply_needed' }); // imported, from our own people

      const customerTypes = ['quotation_request', 'existing_customer', 'new_enquiry'];
      const shown = await service.list(userId, { view: 'needs_response', intents: customerTypes });
      expect(shown.map((i) => i.subject).sort()).toEqual(['drafted', 'unsorted']);
      expect((await service.counts(userId, { intents: customerTypes })).needs_response).toBe(2);
      // Mail the AI did sort as something else stays filtered out, in every view.
      expect((await service.list(userId, { intents: customerTypes })).map((i) => i.subject).sort()).toEqual(['drafted', 'unsorted']);
      expect(unsorted.toJSON()).toMatchObject({ aiRead: false });
      expect(drafted.toJSON()).toMatchObject({ aiRead: true });
    });

    it('"Draft with AI" writes replies for them, and mail that needs no reply leaves the queue', async () => {
      const price = await imported({ subject: 'price?', receivedAt: new Date(Date.now() - 1 * DAY) });
      const news = await imported({ subject: 'newsletter', receivedAt: new Date(Date.now() - 2 * DAY) });
      // The AI is handed the email inside a larger fact sheet; which email it is shows in there.
      httpPost.mockImplementation((_url: string, body: unknown) =>
        of({ data: JSON.stringify(body).includes('newsletter') ? aiNoReply : aiDraft('Hi — the price is ₹450 per unit.') }),
      );

      const run = await sync.draftWaiting(userId, { limit: 10 });

      expect(run).toMatchObject({ drafted: 1, noDraft: 1 });
      expect(run!.error).toBeUndefined();
      expect(await fresh(price)).toMatchObject({
        shouldDraft: true,
        draftReply: 'Hi — the price is ₹450 per unit.',
        aiStatus: 'draft_ready',
        status: 'pending',
      });
      expect(deriveResponseStatus(await fresh(price))).toBe('needs_response');
      expect(deriveResponseStatus(await fresh(news))).toBe('resolved');
      // Each one billed, like any other AI reading.
      expect(reservations.settle).toHaveBeenCalledTimes(2);
      // Nothing is left to draft, and nothing was sent: a draft is only ever a draft.
      expect(await service.countWithoutDraft(userId)).toBe(0);
      expect(sentTo()).toEqual([]);
      expect(sync.draftRunState(userId)).toMatchObject({ running: false, last: { drafted: 1, noDraft: 1 } });
    });

    it('stops at the first failure and says why — no credits is not retried email after email', async () => {
      await imported({ receivedAt: new Date(Date.now() - 1 * DAY) });
      await imported({ receivedAt: new Date(Date.now() - 2 * DAY) });
      await imported({ receivedAt: new Date(Date.now() - 3 * DAY) });
      reservations.reserve.mockRejectedValue(new HttpException('Your Haive Credits are exhausted.', HttpStatus.PAYMENT_REQUIRED));

      const run = await sync.draftWaiting(userId, { limit: 10 });

      expect(run).toMatchObject({ drafted: 0, noDraft: 0, error: expect.stringMatching(/credits are used up/i) });
      expect(reservations.reserve).toHaveBeenCalledTimes(1);
      expect(await service.countWithoutDraft(userId)).toBe(3);
    });

    it('never runs twice at once for the same mailbox, and respects the limit', async () => {
      for (let i = 1; i <= 4; i += 1) await imported({ receivedAt: new Date(Date.now() - i * DAY) });
      httpPost.mockImplementation(() => of({ data: aiDraft('Drafted.') }));

      const [first, second] = await Promise.all([sync.draftWaiting(userId, { limit: 3 }), sync.draftWaiting(userId, { limit: 3 })]);

      expect([first, second].filter(Boolean)).toHaveLength(1);
      expect((first ?? second)!.drafted).toBe(3);
      expect(await service.countWithoutDraft(userId)).toBe(1);
      expect(sync.startDraftRun(userId, { limit: 1 })).toBe(true);
    });
  });

  describe('the owner’s settings', () => {
    it('start as: no automatic drafting, approving sends — and remember what is chosen', async () => {
      expect(await service.getInboxSettings(userId)).toEqual({ autoDraft: false, sendOnApprove: true });
      expect(await service.updateInboxSettings(userId, { autoDraft: true })).toEqual({ autoDraft: true, sendOnApprove: true });
      expect(await service.updateInboxSettings(userId, { sendOnApprove: false })).toEqual({ autoDraft: true, sendOnApprove: false });
      // Anything that is not a yes or a no is ignored.
      expect(await service.updateInboxSettings(userId, { autoDraft: 'yes' as never })).toEqual({ autoDraft: true, sendOnApprove: false });
      expect(await service.getInboxSettings(new Types.ObjectId().toString())).toEqual({ autoDraft: false, sendOnApprove: true });
    });
  });
});
