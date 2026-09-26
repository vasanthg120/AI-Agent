import { BadRequestException } from '@nestjs/common';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { of, throwError } from 'rxjs';
import { EmailIntelligenceService } from './email-intelligence.service';
import {
  EmailIntelligenceItem,
  EmailIntelligenceItemDocument,
  EmailIntelligenceItemSchema,
} from './schemas/email-intelligence-item.schema';

// The AI Email Inbox's reply lifecycle, end to end against a real Mongo and the
// real service (only the outbound Graph/python-agent call, SLA and notification
// side effects are stubbed). Each test is one of the scenarios from the bug
// report: an email that has been replied to must leave the pending views, stay
// out through refresh / sync / reprocessing, keep its history, and never take
// a failed send or a genuinely new message with it.
const PREFIX = `jest-email-flow-${Date.now()}`;
const HOUR = 3_600_000;

describe('AI Email Inbox — reply lifecycle (real Mongo)', () => {
  let connection: Connection;
  let model: Model<EmailIntelligenceItemDocument>;
  let service: EmailIntelligenceService;
  let httpPost: jest.Mock;
  let recordFirstResponse: jest.Mock;
  let seq = 0;
  let userId: string;
  let orgId: string;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([{ name: EmailIntelligenceItem.name, schema: EmailIntelligenceItemSchema }]),
      ],
    }).compile();
    model = moduleRef.get(getModelToken(EmailIntelligenceItem.name));
    connection = model.db;
    await model.init(); // build the unique {userId, externalMessageId} index before the duplicate test
  });

  beforeEach(() => {
    seq += 1;
    userId = `${PREFIX}-user-${seq}`;
    orgId = `${PREFIX}-org-${seq}`;
    httpPost = jest.fn(() => of({ data: {} }));
    recordFirstResponse = jest.fn(async () => undefined);
    service = new EmailIntelligenceService(
      model,
      {} as never, // followUpModel — not exercised
      { create: jest.fn() } as never, // notifications
      {} as never, // customerActivity
      {} as never, // quotes
      { findById: async () => null, findAll: async () => [] } as never, // users — no salesperson, so post-send CRM actions no-op
      { post: httpPost, get: jest.fn() } as never,
      { sign: () => 'token' } as never,
      { get: () => undefined } as never,
      { recordFirstResponse, createOrUpdateRecordForItem: jest.fn() } as never, // email SLA
      {} as never, // reservations
    );
  });

  afterAll(async () => {
    await model.deleteMany({ userId: { $regex: `^${PREFIX}` } });
    await connection.close();
  });

  async function receive(overrides: Record<string, unknown> = {}) {
    const n = ++seq * 1000 + Math.floor(Math.random() * 1000);
    return model.create({
      organizationId: orgId,
      userId,
      mailboxEmail: 'me@example.com',
      externalMessageId: `${PREFIX}-msg-${n}`,
      conversationId: `${PREFIX}-conv-A`,
      receivedAt: new Date(Date.now() - 3 * HOUR),
      subject: 'Quote for 200 units',
      fromAddress: 'customer@example.com',
      intent: 'quotation_request',
      priority: 'high',
      urgency: 'high',
      sentiment: 'neutral',
      recommendedAction: 'Reply with a quote',
      shouldDraft: true,
      draftReply: 'Hi — here is the quote.',
      expectedNextAction: 'company_reply',
      aiStatus: 'draft_ready',
      // Non-empty on purpose: Mongoose drops an empty {} on save, which would trip these two
      // required paths on the next save() — real ingested items always carry content here.
      deterministicInput: { fixture: true },
      result: { fixture: true },
      ...overrides,
    });
  }

  const ids = (rows: { _id: unknown }[]) => rows.map((r) => String(r._id)).sort();
  const view = (v: 'needs_response' | 'responded' | 'resolved') => service.list(userId, { view: v });
  const approveAndSend = async (id: string) => {
    await service.approve(userId, id);
    return service.send(userId, id);
  };

  it('1-2. an incoming email needs a response, and opening/reading it changes nothing', async () => {
    const email = await receive({ isRead: false });
    expect(ids(await view('needs_response'))).toEqual(ids([email]));

    await model.updateOne({ _id: email._id }, { isRead: true }); // opened
    expect(ids(await view('needs_response'))).toEqual(ids([email]));
    expect(await service.counts(userId)).toEqual({ needs_response: 1, responded: 0, resolved: 0 });
  });

  it('3-4. replying through the app moves it out of Needs Response at once, and it stays out on re-read', async () => {
    const email = await receive();
    const sent = await approveAndSend(email._id.toString());

    expect(sent.sentAt).toBeInstanceOf(Date);
    expect((sent.toJSON() as unknown as Record<string, unknown>).responseStatus).toBe('responded');
    expect(await view('needs_response')).toHaveLength(0);
    expect(ids(await view('responded'))).toEqual(ids([email]));
    expect(await service.counts(userId)).toEqual({ needs_response: 0, responded: 1, resolved: 0 });

    // "page refresh / log out and back in" — a brand-new read of the same data
    const reloaded = await service.getOne(userId, email._id.toString());
    expect(reloaded.responseStatus).toBe('responded');
    expect(reloaded.respondedVia).toBe('app');
  });

  it('6. a sync that finds the reply in Sent Items cannot bring a replied email back', async () => {
    const email = await receive();
    await approveAndSend(email._id.toString());

    // the app's own reply shows up in Sent Items with a later time, as it would
    const marked = await service.markExternalReplies(userId, new Map([[email.conversationId!, new Date()]]));
    expect(marked).toBe(0); // nothing left open to mark
    const again = await service.getOne(userId, email._id.toString());
    expect(again.responseStatus).toBe('responded');
    expect(again.respondedVia).toBe('app'); // sync did not overwrite the real send time
    expect(await view('needs_response')).toHaveLength(0);
  });

  it('a reply typed into Outlook resolves the email even though its approval status stays pending', async () => {
    const email = await receive();
    expect(email.status).toBe('pending');

    const marked = await service.markExternalReplies(userId, new Map([[email.conversationId!, new Date()]]));

    expect(marked).toBe(1);
    const after = await service.getOne(userId, email._id.toString());
    expect(after.status).toBe('pending'); // the AI-draft workflow state is untouched...
    expect(after.responseStatus).toBe('responded'); // ...but it is no longer awaiting a reply
    expect(after.respondedVia).toBe('outlook');
    expect(await view('needs_response')).toHaveLength(0);
    // and running the sync again is a no-op, not a second write
    expect(await service.markExternalReplies(userId, new Map([[email.conversationId!, new Date()]]))).toBe(0);
  });

  it('an approved-but-unsent draft that was answered in Outlook instead is resolved too', async () => {
    const email = await receive();
    await service.approve(userId, email._id.toString());
    expect(ids(await view('needs_response'))).toEqual(ids([email])); // approved is NOT answered

    await service.markExternalReplies(userId, new Map([[email.conversationId!, new Date()]]));

    expect(await view('needs_response')).toHaveLength(0);
    expect(ids(await view('responded'))).toEqual(ids([email]));
  });

  it('7. replying answers the whole thread: older open messages resolve immediately, a newer one does not', async () => {
    const older1 = await receive({ receivedAt: new Date(Date.now() - 6 * HOUR), externalMessageId: `${PREFIX}-o1-${seq}` });
    const older2 = await receive({ receivedAt: new Date(Date.now() - 5 * HOUR), externalMessageId: `${PREFIX}-o2-${seq}` });
    const replied = await receive({ receivedAt: new Date(Date.now() - 4 * HOUR), externalMessageId: `${PREFIX}-r-${seq}` });
    const otherThread = await receive({ conversationId: `${PREFIX}-conv-B`, externalMessageId: `${PREFIX}-x-${seq}` });

    await approveAndSend(replied._id.toString());

    expect(ids(await view('needs_response'))).toEqual(ids([otherThread])); // only the unrelated thread is still open
    const older = await Promise.all([older1, older2].map((o) => service.getOne(userId, o._id.toString())));
    for (const o of older) {
      expect(o.responseStatus).toBe('responded');
      expect(o.respondedVia).toBe('thread'); // covered by the later reply, not sent itself
      expect(o.sentAt).toBeUndefined(); // "sent" analytics are not inflated
    }
    // their SLA records are closed too, so they can't breach and spawn a follow-up:
    // the two covered messages plus the one actually replied to, and nothing else
    const closed = recordFirstResponse.mock.calls.map((c) => c[1]).sort();
    expect(closed).toEqual([older1, older2, replied].map((r) => String(r._id)).sort());
  });

  it('9. a new message arriving after the reply is judged on its own', async () => {
    const first = await receive({ receivedAt: new Date(Date.now() - 4 * HOUR) });
    await approveAndSend(first._id.toString());

    const followUp = await receive({ receivedAt: new Date(Date.now() + 60_000), externalMessageId: `${PREFIX}-later-${seq}` });

    expect(ids(await view('needs_response'))).toEqual(ids([followUp]));
    expect(ids(await view('responded'))).toEqual(ids([first]));
    // and a sync that sees the earlier reply does not swallow the newer message
    await service.markExternalReplies(userId, new Map([[first.conversationId!, new Date(first.sentAt ?? Date.now())]]));
    expect(ids(await view('needs_response'))).toEqual(ids([followUp]));
  });

  it('a later message that is itself "no reply needed" does not reopen the thread', async () => {
    const first = await receive();
    await approveAndSend(first._id.toString());
    const thanks = await receive({
      receivedAt: new Date(Date.now() + 60_000),
      externalMessageId: `${PREFIX}-thanks-${seq}`,
      shouldDraft: false,
      expectedNextAction: 'no_action_required',
      aiStatus: 'no_reply_needed',
    });

    expect(await view('needs_response')).toHaveLength(0);
    expect(ids(await view('resolved'))).toEqual(ids([thanks]));
  });

  it('8. a failed send leaves the email needing a response, with the error, and a retry can still work', async () => {
    const email = await receive();
    await service.approve(userId, email._id.toString());
    httpPost.mockReturnValueOnce(throwError(() => new Error('Graph 503')));

    await expect(service.send(userId, email._id.toString())).rejects.toThrow(BadRequestException);

    const after = await service.getOne(userId, email._id.toString());
    expect(after.sentAt).toBeUndefined();
    expect(after.sendError).toContain('Graph 503');
    expect(after.responseStatus).toBe('needs_response');
    expect(ids(await view('needs_response'))).toEqual(ids([email])); // approved, unsent, failed: still owed
    expect(recordFirstResponse).not.toHaveBeenCalled();

    const retried = await service.send(userId, email._id.toString());
    expect(retried.sentAt).toBeInstanceOf(Date);
    expect(retried.sendError).toBeUndefined();
    expect(await view('needs_response')).toHaveLength(0);
  });

  it('a draft that was answered elsewhere cannot be sent again (no duplicate reply)', async () => {
    const email = await receive();
    await service.approve(userId, email._id.toString());
    await service.markExternalReplies(userId, new Map([[email.conversationId!, new Date()]]));

    await expect(service.send(userId, email._id.toString())).rejects.toThrow(/already been replied to/);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it('10. counts always equal the rows behind each tab, under filters too', async () => {
    const a = await receive({ intent: 'vendor', subject: 'Invoice question' });
    const b = await receive({ intent: 'complaint', subject: 'Late delivery', conversationId: `${PREFIX}-conv-B` });
    await receive({ shouldDraft: false, expectedNextAction: 'no_action_required', aiStatus: 'no_reply_needed', conversationId: `${PREFIX}-conv-C` });
    await approveAndSend(a._id.toString());

    const counts = await service.counts(userId);
    expect(counts).toEqual({ needs_response: 1, responded: 1, resolved: 1 });
    for (const v of ['needs_response', 'responded', 'resolved'] as const) {
      expect(await view(v)).toHaveLength(counts[v]);
    }
    // the same filters narrow both
    expect(await service.counts(userId, { intents: ['complaint'] })).toEqual({ needs_response: 1, responded: 0, resolved: 0 });
    expect(ids(await service.list(userId, { view: 'needs_response', intents: ['complaint'] }))).toEqual(ids([b]));
    expect(ids(await service.list(userId, { search: 'late deliv' }))).toEqual(ids([b]));
  });

  it('11. the same message can never be stored twice', async () => {
    const email = await receive();
    await expect(
      model.create({ ...email.toObject(), _id: undefined, __v: undefined }),
    ).rejects.toMatchObject({ code: 11000 });
    expect(await model.countDocuments({ userId })).toBe(1);
  });

  it('12. a replied-to email stays available: in the Responded view, with its whole conversation', async () => {
    const question = await receive({ receivedAt: new Date(Date.now() - 5 * HOUR), externalMessageId: `${PREFIX}-q-${seq}` });
    const chaser = await receive({ receivedAt: new Date(Date.now() - 4 * HOUR), externalMessageId: `${PREFIX}-c-${seq}` });
    await approveAndSend(chaser._id.toString());

    expect(ids(await view('responded'))).toEqual(ids([question, chaser]));
    const { conversationId, messages } = await service.thread(userId, chaser._id.toString());
    expect(conversationId).toBe(chaser.conversationId);
    expect(messages.map((m) => String(m._id))).toEqual([String(question._id), String(chaser._id)]); // oldest first
    expect(messages.map((m) => m.respondedVia)).toEqual(['thread', 'app']);
  });

  it('never leaks another user\'s mail through list, counts or thread', async () => {
    const mine = await receive();
    const theirs = await model.create({
      ...mine.toObject(),
      _id: undefined,
      __v: undefined,
      userId: `${PREFIX}-someone-else`,
      externalMessageId: `${PREFIX}-theirs-${seq}`,
    });
    expect(ids(await service.list(userId))).toEqual(ids([mine]));
    expect((await service.counts(userId)).needs_response).toBe(1);
    await expect(service.thread(userId, theirs._id.toString())).rejects.toThrow(/not found/i);
  });

  describe('list ordering and paging', () => {
    it('urgency puts what must be answered soonest first, and paging keeps one consistent order', async () => {
      const low = await receive({ urgency: 'low', priority: 'low', conversationId: `${PREFIX}-c1`, externalMessageId: `${PREFIX}-p1-${seq}` });
      const urgent = await receive({ urgency: 'urgent', priority: 'medium', conversationId: `${PREFIX}-c2`, externalMessageId: `${PREFIX}-p2-${seq}` });
      const highOld = await receive({ urgency: 'high', priority: 'urgent', receivedAt: new Date(Date.now() - 9 * HOUR), conversationId: `${PREFIX}-c3`, externalMessageId: `${PREFIX}-p3-${seq}` });
      const highNew = await receive({ urgency: 'high', priority: 'urgent', conversationId: `${PREFIX}-c4`, externalMessageId: `${PREFIX}-p4-${seq}` });

      const all = await service.list(userId, { sort: 'urgency' });
      expect(all.map((r) => String(r._id))).toEqual([urgent, highNew, highOld, low].map((r) => String(r._id)));

      const page1 = await service.list(userId, { sort: 'urgency', limit: 2, skip: 0 });
      const page2 = await service.list(userId, { sort: 'urgency', limit: 2, skip: 2 });
      expect([...page1, ...page2].map((r) => String(r._id))).toEqual(all.map((r) => String(r._id)));
      expect((page1[0].toJSON() as unknown as Record<string, unknown>).responseStatus).toBe('needs_response'); // hydrated rows carry derived state
    });

    it('newest / oldest sort by arrival time', async () => {
      const first = await receive({ receivedAt: new Date(Date.now() - 8 * HOUR), conversationId: `${PREFIX}-n1`, externalMessageId: `${PREFIX}-n1-${seq}` });
      const second = await receive({ receivedAt: new Date(Date.now() - 2 * HOUR), conversationId: `${PREFIX}-n2`, externalMessageId: `${PREFIX}-n2-${seq}` });
      expect(ids(await service.list(userId, { sort: 'newest' }))).toEqual(ids([first, second]));
      expect((await service.list(userId, { sort: 'newest' }))[0]._id).toEqual(second._id);
      expect((await service.list(userId, { sort: 'oldest' }))[0]._id).toEqual(first._id);
    });

    it('a regex-looking search is matched literally, not executed', async () => {
      await receive({ subject: 'Re: (urgent) price [Q3]' });
      expect(await service.list(userId, { search: '(urgent) price [Q3]' })).toHaveLength(1);
      expect(await service.list(userId, { search: '.*' })).toHaveLength(0);
    });
  });

  describe('dashboards and reports use the same definition', () => {
    const range = () => [new Date(Date.now() - 48 * HOUR), new Date(Date.now() + HOUR)] as const;

    it('an answered email is not "missed"; an approved draft that never went out still is', async () => {
      const answered = await receive({ receivedAt: new Date(Date.now() - 30 * HOUR), conversationId: `${PREFIX}-m1`, externalMessageId: `${PREFIX}-m1-${seq}` });
      const external = await receive({ receivedAt: new Date(Date.now() - 30 * HOUR), conversationId: `${PREFIX}-m2`, externalMessageId: `${PREFIX}-m2-${seq}` });
      const failedSend = await receive({ receivedAt: new Date(Date.now() - 30 * HOUR), conversationId: `${PREFIX}-m3`, externalMessageId: `${PREFIX}-m3-${seq}` });
      const noReplyNeeded = await receive({ receivedAt: new Date(Date.now() - 30 * HOUR), conversationId: `${PREFIX}-m4`, externalMessageId: `${PREFIX}-m4-${seq}`, shouldDraft: false, expectedNextAction: 'no_action_required', aiStatus: 'no_reply_needed' });
      const trulyMissed = await receive({ receivedAt: new Date(Date.now() - 30 * HOUR), conversationId: `${PREFIX}-m5`, externalMessageId: `${PREFIX}-m5-${seq}` });

      await approveAndSend(answered._id.toString());
      await service.markExternalReplies(userId, new Map([[external.conversationId!, new Date()]]));
      await service.approve(userId, failedSend._id.toString()); // approved, never sent

      const [start, end] = range();
      const missed = await service.listActivity(orgId, 'missed', start, end);
      expect(ids(missed)).toEqual(ids([failedSend, trulyMissed]));
      expect(ids(missed)).not.toContain(String(answered._id));
      expect(ids(missed)).not.toContain(String(external._id));
      expect(ids(missed)).not.toContain(String(noReplyNeeded._id));
      expect((await service.getActivityStats(orgId, start, end)).missedCount).toBe(2);
    });
  });

  describe('read state', () => {
    it('refreshReadState updates only isRead, only when it changed, and never the response state', async () => {
      const email = await receive({ isRead: false });
      const answered = await receive({ isRead: false, conversationId: `${PREFIX}-rs2`, externalMessageId: `${PREFIX}-rs2-${seq}` });
      await approveAndSend(answered._id.toString());

      const changed = await service.refreshReadState(userId, [
        { id: email.externalMessageId, isRead: true },
        { id: answered.externalMessageId, isRead: true },
        { id: 'not-in-this-mailbox', isRead: true },
      ]);
      expect(changed).toBe(2);
      expect(await service.refreshReadState(userId, [{ id: email.externalMessageId, isRead: true }])).toBe(0); // unchanged -> no write

      expect((await service.getOne(userId, email._id.toString())).isRead).toBe(true);
      expect((await service.getOne(userId, email._id.toString())).responseStatus).toBe('needs_response');
      expect((await service.getOne(userId, answered._id.toString())).responseStatus).toBe('responded');
      // marking it unread again in Outlook does not resurrect it either
      await service.refreshReadState(userId, [{ id: answered.externalMessageId, isRead: false }]);
      expect((await service.getOne(userId, answered._id.toString())).responseStatus).toBe('responded');
    });
  });
});
