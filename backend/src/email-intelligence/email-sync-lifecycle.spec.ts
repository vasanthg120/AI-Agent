import { HttpException } from '@nestjs/common';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { of, throwError } from 'rxjs';
import { AgentExecution, AgentExecutionDocument, AgentExecutionSchema } from '../command-center/schemas/agent-execution.schema';
import { OutlookConnection, OutlookConnectionDocument, OutlookConnectionSchema } from '../outlook/schemas/outlook-connection.schema';
import { EmailConversationService } from './email-conversation.service';
import { EmailHistoryService } from './email-history.service';
import { EmailIntelligenceSyncService } from './email-intelligence-sync.service';
import { EmailIntelligenceService } from './email-intelligence.service';
import { EmailFollowUpReminder, EmailFollowUpReminderDocument, EmailFollowUpReminderSchema } from './schemas/email-follow-up-reminder.schema';
import { EmailIntelligenceItem, EmailIntelligenceItemDocument, EmailIntelligenceItemSchema } from './schemas/email-intelligence-item.schema';
import { EmailSentItem, EmailSentItemDocument, EmailSentItemSchema } from './schemas/email-sent-item.schema';
import { EmailSyncJob, EmailSyncJobDocument, EmailSyncJobSchema } from './schemas/email-sync-job.schema';

// The whole lifecycle — Outlook → sync → conversation → response state → API —
// against a real Mongo with the real services. Only Outlook itself (the
// python-agent's /outlook routes) and the AI call are replaced, by a small
// in-memory mailbox per user that behaves like one: what is "sent" appears in
// its Sent Items, what is deleted disappears.
const PREFIX = `jest-mail-life-${Date.now()}`;
const MIN = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN).toISOString();

interface FakeInbound {
  id: string;
  subject: string;
  from: string;
  fromName?: string;
  to: string[];
  receivedAt: string;
  preview: string;
  isRead: boolean;
  importance: string;
  conversationId: string;
  internetMessageId: string;
  inReplyTo?: string;
  references?: string[];
  deleted?: boolean;
}
interface FakeSent {
  id: string;
  conversationId: string;
  sentAt: string;
  subject: string;
  from: string;
  to: string[];
  preview: string;
  internetMessageId: string;
  inReplyTo?: string;
  references?: string[];
}
interface Mailbox {
  address: string;
  aliases: string[];
  inbox: FakeInbound[];
  sent: FakeSent[];
}

describe('AI Email Inbox — Outlook sync to response state (real Mongo)', () => {
  let connection: Connection;
  let items: Model<EmailIntelligenceItemDocument>;
  let sent: Model<EmailSentItemDocument>;
  let reminders: Model<EmailFollowUpReminderDocument>;
  let connections: Model<OutlookConnectionDocument>;
  let jobs: Model<EmailSyncJobDocument>;
  let executions: Model<AgentExecutionDocument>;

  let inboxService: EmailIntelligenceService;
  let sync: EmailIntelligenceSyncService;
  let conversations: EmailConversationService;

  const mailboxes = new Map<string, Mailbox>();
  let aiAvailable = true;
  let aiCalls: Record<string, unknown>[] = [];
  let replySends = 0;
  let seq = 0;
  let org: string;
  let me: string;

  // The caller's identity travels as the "token": sign() returns the user id.
  const mailboxOf = (config: { headers?: { Authorization?: string } }) => mailboxes.get((config.headers?.Authorization ?? '').replace('Bearer ', ''))!;

  const http = {
    get: jest.fn((url: string, config: { params?: { since?: string }; headers?: { Authorization?: string } }) => {
      const box = mailboxOf(config);
      if (!box) return of({ data: { connected: false, emails: [], items: [] } });
      const since = new Date(config.params?.since ?? 0).getTime();
      const addresses = [box.address, ...box.aliases];
      if (url.endsWith('/outlook/messages-since')) {
        const emails = box.inbox.filter((m) => !m.deleted && new Date(m.receivedAt).getTime() >= since);
        return of({ data: { connected: true, emails, truncated: false, mailboxAddresses: addresses } });
      }
      if (url.endsWith('/outlook/sent-since')) {
        return of({
          data: { connected: true, items: box.sent.filter((m) => new Date(m.sentAt).getTime() >= since), truncated: false, mailboxAddresses: addresses },
        });
      }
      throw new Error(`unexpected GET ${url}`);
    }),
    post: jest.fn((url: string, body: Record<string, unknown>, config: { headers?: { Authorization?: string } }) => {
      if (url.endsWith('/email-intelligence/analyze')) {
        if (!aiAvailable) return throwError(() => new Error('connect ECONNREFUSED'));
        aiCalls.push(body);
        return of({
          data: {
            intent: 'quotation_request',
            priority: 'high',
            urgency: 'medium',
            sentiment: 'neutral',
            recommendedAction: 'Send the quotation.',
            shouldDraft: true,
            draftReply: 'Hi, thanks for your email — the quotation is on its way.',
            draftReasoning: 'The customer asked for a quotation.',
            draftWrittenFromOurPerspective: true,
          },
        });
      }
      const box = mailboxOf(config);
      if (url.endsWith('/outlook/send-reply')) {
        replySends += 1;
        const original = box.inbox.find((m) => m.id === body.messageId)!;
        // What Outlook does: the reply lands in Sent Items, in the same conversation, answering that message.
        box.sent.push({
          id: `sent-${box.sent.length + 1}-${Date.now()}`,
          conversationId: original.conversationId,
          sentAt: new Date().toISOString(),
          subject: `RE: ${original.subject}`,
          from: box.address,
          to: [original.from],
          preview: String(body.comment).slice(0, 200),
          internetMessageId: `<reply-${box.sent.length + 1}-${Date.now()}@us>`,
          inReplyTo: original.internetMessageId,
          references: [original.internetMessageId],
        });
        return of({ data: { sent: true } });
      }
      if (url.endsWith('/outlook/messages-state')) {
        const refs = body.messages as { id: string; internetMessageId?: string }[];
        // As Outlook does: a moved message is no longer found by its old id, only by its Message-ID.
        const states = refs.map((ref) => {
          const message = box.inbox.find((m) => m.id === ref.id) ?? box.inbox.find((m) => m.internetMessageId === ref.internetMessageId);
          const state = !message ? 'gone' : message.deleted ? 'deleted' : message.id === ref.id ? 'present' : 'moved';
          return { id: ref.id, state, newId: state === 'moved' ? message!.id : null, isRead: message?.isRead ?? null };
        });
        return of({ data: { connected: true, states } });
      }
      throw new Error(`unexpected POST ${url}`);
    }),
  };

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: EmailIntelligenceItem.name, schema: EmailIntelligenceItemSchema },
          { name: EmailSentItem.name, schema: EmailSentItemSchema },
          { name: EmailFollowUpReminder.name, schema: EmailFollowUpReminderSchema },
          { name: OutlookConnection.name, schema: OutlookConnectionSchema },
          { name: EmailSyncJob.name, schema: EmailSyncJobSchema },
          { name: AgentExecution.name, schema: AgentExecutionSchema },
        ]),
      ],
    }).compile();
    items = moduleRef.get(getModelToken(EmailIntelligenceItem.name));
    sent = moduleRef.get(getModelToken(EmailSentItem.name));
    reminders = moduleRef.get(getModelToken(EmailFollowUpReminder.name));
    connections = moduleRef.get(getModelToken(OutlookConnection.name));
    jobs = moduleRef.get(getModelToken(EmailSyncJob.name));
    executions = moduleRef.get(getModelToken(AgentExecution.name));
    connection = items.db;
    // The unique indexes are part of what is being tested (no duplicates, one sync at a time).
    await Promise.all([items.init(), sent.init(), jobs.init(), connections.init()]);

    const users = { findById: async (id: string) => ({ _id: id, organizationId: orgOf(id), name: 'Sam Seller' }), findAll: async () => [] };
    const customerActivity = {
      gatherCorrelationContext: async () => ({
        exactEmails: new Set(),
        domains: new Set(),
        businessNamesForFuzzy: [],
        emailToGroupKey: new Map(),
        domainToGroupKey: new Map(),
        groups: new Map(),
      }),
    };
    const jwt = { sign: (payload: { sub: string }) => payload.sub };
    const config = { get: () => 'http://agent' };
    const sla = { recordFirstResponse: jest.fn(async () => undefined), createOrUpdateRecordForItem: jest.fn(async () => undefined) };
    const reservations = {
      resolveTenantKey: (o: string) => o,
      reserve: jest.fn(async () => {
        if (creditsExhausted) throw new HttpException({ code: 'INSUFFICIENT_BALANCE' }, 402);
      }),
      settle: jest.fn(async () => undefined),
      release: jest.fn(async () => undefined),
    };
    inboxService = new EmailIntelligenceService(
      items,
      reminders,
      { create: jest.fn(async () => undefined) } as never,
      customerActivity as never,
      {} as never,
      users as never,
      http as never,
      jwt as never,
      config as never,
      sla as never,
      reservations as never,
    );
    conversations = new EmailConversationService(items, sent, connections, sla as never);
    const history = new EmailHistoryService(
      items,
      sent,
      reminders,
      connections,
      inboxService,
      conversations,
      customerActivity as never,
      users as never,
      http as never,
      jwt as never,
      config as never,
    );
    sync = new EmailIntelligenceSyncService(
      connections,
      jobs,
      executions,
      users as never,
      customerActivity as never,
      inboxService,
      history,
      conversations,
      http as never,
      jwt as never,
      config as never,
    );
  });

  let creditsExhausted = false;
  const orgs = new Map<string, string>();
  const orgOf = (userId: string) => orgs.get(userId) ?? 'unknown-org';

  async function connectMailbox(userId: string, organizationId: string, address: string, aliases: string[] = []): Promise<Mailbox> {
    orgs.set(userId, organizationId);
    const box: Mailbox = { address, aliases, inbox: [], sent: [] };
    mailboxes.set(userId, box);
    await connections.create({
      userId,
      organizationId,
      email: address,
      accessToken: 'x',
      refreshToken: 'x',
      expiresAt: new Date(Date.now() + 3_600_000),
      isActive: true,
      status: 'connected',
    });
    return box;
  }

  let box: Mailbox;
  beforeEach(async () => {
    seq += 1;
    org = `${PREFIX}-org-${seq}`;
    me = `${PREFIX}-user-${seq}`;
    aiAvailable = true;
    creditsExhausted = false;
    aiCalls = [];
    replySends = 0;
    box = await connectMailbox(me, org, 'sam@fullypromoted.in');
  });

  afterAll(async () => {
    const mine = { userId: { $regex: `^${PREFIX}` } };
    await Promise.all([items.deleteMany(mine), sent.deleteMany(mine), reminders.deleteMany(mine), connections.deleteMany(mine), jobs.deleteMany(mine)]);
    await connection.close();
  });

  let n = 0;
  function customerWrites(target: Mailbox, overrides: Partial<FakeInbound> = {}): FakeInbound {
    n += 1;
    const message: FakeInbound = {
      id: `${PREFIX}-in-${n}`,
      subject: 'Pricing for 250 polo shirts',
      from: 'priya@customer.com',
      fromName: 'Priya Raman',
      to: [target.address],
      receivedAt: ago(60),
      preview: 'Can you provide pricing?',
      isRead: false,
      importance: 'normal',
      conversationId: `${PREFIX}-conv-${seq}`,
      internetMessageId: `<in-${n}-${PREFIX}@customer.com>`,
      ...overrides,
    };
    target.inbox.push(message);
    return message;
  }
  function repliesInOutlook(target: Mailbox, to: FakeInbound, overrides: Partial<FakeSent> = {}): FakeSent {
    n += 1;
    const message: FakeSent = {
      id: `${PREFIX}-out-${n}`,
      conversationId: to.conversationId,
      sentAt: ago(30),
      subject: `RE: ${to.subject}`,
      from: target.address,
      to: [to.from],
      preview: 'Sure, I will send the pricing today.',
      internetMessageId: `<out-${n}-${PREFIX}@us>`,
      inReplyTo: to.internetMessageId,
      references: [to.internetMessageId],
      ...overrides,
    };
    target.sent.push(message);
    return message;
  }
  const waiting = (userId = me) => inboxService.list(userId, { view: 'needs_response' });
  const answered = (userId = me) => inboxService.list(userId, { view: 'responded' });

  it('Test 1 — a customer email nobody has answered needs a response', async () => {
    customerWrites(box);
    const result = await sync.syncMyMailbox(me);
    expect(result).toMatchObject({ connected: true, newItemsCount: 1 });

    const rows = await waiting();
    expect(rows).toHaveLength(1);
    expect(rows[0].responseStatus).toBe('needs_response');
    expect(rows[0].category).toBe('needs_response');
    expect(rows[0].fromName).toBe('Priya Raman');
    expect(await inboxService.counts(me)).toMatchObject({ needs_response: 1, responded: 0 });
  });

  it('Test 2 / 9 — the employee replies in Outlook: the next reply check moves it to Responded', async () => {
    const question = customerWrites(box);
    await sync.syncMyMailbox(me);
    expect(await waiting()).toHaveLength(1);

    repliesInOutlook(box, question);
    const refresh = await sync.refreshReplies(me, { force: true });
    expect(refresh).toMatchObject({ connected: true, answered: 1 });

    expect(await waiting()).toHaveLength(0);
    const [row] = await answered();
    expect(row).toMatchObject({ responseStatus: 'responded', respondedVia: 'outlook', replyMatchedVia: 'reference', category: 'responded' });
    expect(row.replyPreview).toContain('I will send the pricing today');
    expect(await inboxService.counts(me)).toMatchObject({ needs_response: 0, responded: 1 });
    // No AI was involved in noticing the reply.
    expect(aiCalls).toHaveLength(1);
  });

  it('Test 2b — a reply Outlook filed under a different conversation, with a changed subject, is still recognised by its headers', async () => {
    const question = customerWrites(box);
    await sync.syncMyMailbox(me);
    repliesInOutlook(box, question, { conversationId: `${PREFIX}-conv-split-${seq}`, subject: 'Your quotation' });
    await sync.refreshReplies(me, { force: true });
    expect(await waiting()).toHaveLength(0);
    expect((await answered())[0].replyMatchedVia).toBe('reference');
  });

  it('Test 3 — replying from HaiVE: approve, send, and it is Responded at once; a double click sends once', async () => {
    customerWrites(box);
    await sync.syncMyMailbox(me);
    const [row] = await waiting();
    expect(row.draftReply).toBeTruthy();

    await inboxService.approve(me, row._id.toString());
    const attempts = await Promise.allSettled([inboxService.send(me, row._id.toString()), inboxService.send(me, row._id.toString())]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    expect(replySends).toBe(1);
    expect(box.sent).toHaveLength(1);

    expect(await waiting()).toHaveLength(0);
    expect((await answered())[0]).toMatchObject({ respondedVia: 'app' });

    // The sent message comes back from Outlook on the next check and changes nothing.
    await sync.refreshReplies(me, { force: true });
    expect(await sent.countDocuments({ userId: me })).toBe(1);
    expect(await waiting()).toHaveLength(0);
    await expect(inboxService.send(me, row._id.toString())).rejects.toThrow(/already been sent/);
    expect(replySends).toBe(1);
  });

  it('Test 4 — the customer writes again after our reply: the conversation needs a response again, once', async () => {
    const first = customerWrites(box, { receivedAt: ago(120) });
    await sync.syncMyMailbox(me);
    repliesInOutlook(box, first, { sentAt: ago(90) });
    await sync.refreshReplies(me, { force: true });
    expect(await waiting()).toHaveLength(0);

    customerWrites(box, { receivedAt: ago(10), preview: 'Thanks — can you also quote for caps?', inReplyTo: box.sent[0].internetMessageId });
    await sync.syncMyMailbox(me);

    const rows = await waiting();
    expect(rows).toHaveLength(1);
    expect(rows[0].bodyPreview).toContain('caps');
    expect(rows[0].threadMessageCount).toBe(2);
    // One conversation, one place: it is not also listed as Responded.
    expect(await answered()).toHaveLength(0);
    expect(await inboxService.counts(me)).toMatchObject({ needs_response: 1, responded: 0 });
    // The AI read the new message together with the conversation so far, both directions.
    const thread = aiCalls[aiCalls.length - 1].thread as { direction: string }[];
    expect(thread.map((m) => m.direction)).toEqual(['inbound', 'outbound']);
  });

  it('Test 5 — three emails from the customer are one conversation to answer, and one reply answers it', async () => {
    customerWrites(box, { receivedAt: ago(180), preview: 'First' });
    customerWrites(box, { receivedAt: ago(120), preview: 'Second' });
    const latest = customerWrites(box, { receivedAt: ago(60), preview: 'Third — any update?' });
    await sync.syncMyMailbox(me);

    const rows = await waiting();
    expect(rows).toHaveLength(1);
    expect(rows[0].bodyPreview).toContain('Third');
    expect(rows[0].threadMessageCount).toBe(3);
    expect(await inboxService.counts(me)).toMatchObject({ needs_response: 1 });
    expect(await items.countDocuments({ userId: me })).toBe(3); // all three are kept, as one thread

    repliesInOutlook(box, latest);
    await sync.refreshReplies(me, { force: true });
    expect(await waiting()).toHaveLength(0);
    expect(await answered()).toHaveLength(1);
    // Every message of the conversation is on record as answered, not just the newest.
    expect(await items.countDocuments({ userId: me, externalReplyDetectedAt: { $exists: true } })).toBe(3);
  });

  it('Test 6 — an unrelated email the employee sends does not mark another conversation as answered', async () => {
    const question = customerWrites(box);
    await sync.syncMyMailbox(me);
    // To someone else entirely, and to the same customer about something else.
    box.sent.push({
      ...repliesInOutlook(box, question),
      id: 'x1',
      to: ['other@elsewhere.com'],
      conversationId: 'conv-other',
      subject: 'Lunch?',
      inReplyTo: undefined,
      references: [],
    });
    box.sent.splice(0, 1);
    box.sent.push({
      id: 'x2',
      conversationId: 'conv-invoice',
      sentAt: ago(20),
      subject: 'Invoice 1042',
      from: box.address,
      to: [question.from],
      preview: 'Attached.',
      internetMessageId: '<x2@us>',
    });
    await sync.refreshReplies(me, { force: true });
    expect(await waiting()).toHaveLength(1);

    // Forwarding the customer's email to a colleague is not a reply either.
    box.sent.push({
      id: 'x3',
      conversationId: question.conversationId,
      sentAt: ago(15),
      subject: `FW: ${question.subject}`,
      from: box.address,
      to: ['manager@fullypromoted.in'],
      preview: 'Can you look?',
      internetMessageId: '<x3@us>',
    });
    await sync.refreshReplies(me, { force: true });
    expect(await waiting()).toHaveLength(1);
  });

  it('Test 7 — syncing again, a moved message, and two syncs at once never create duplicates', async () => {
    const question = customerWrites(box);
    await sync.syncMyMailbox(me);
    await sync.syncMyMailbox(me);
    expect(await items.countDocuments({ userId: me })).toBe(1);
    expect(aiCalls).toHaveLength(1);

    // Moved to another folder in Outlook: same message, new Outlook id.
    question.id = `${question.id}-moved`;
    await sync.syncMyMailbox(me);
    expect(await items.countDocuments({ userId: me })).toBe(1);
    expect((await items.findOne({ userId: me }))!.externalMessageId).toBe(question.id);
    expect(aiCalls).toHaveLength(1);

    customerWrites(box, { conversationId: `${PREFIX}-conv-other-${seq}`, subject: 'Another question', receivedAt: ago(1) });
    const both = await Promise.all([sync.syncMyMailbox(me), sync.syncMyMailbox(me)]);
    expect(both.filter((r) => r.alreadyRunning)).toHaveLength(1);
    expect(await items.countDocuments({ userId: me })).toBe(2);
    expect(aiCalls).toHaveLength(2);
    expect(await jobs.countDocuments({ userId: me, status: 'running' })).toBe(0);
  });

  it('Test 8 — after a refresh the state is the same: it lives in the database, not in the page', async () => {
    const question = customerWrites(box);
    await sync.syncMyMailbox(me);
    repliesInOutlook(box, question);
    await sync.refreshReplies(me, { force: true });

    // A brand-new service instance (as after a restart) reads the same answer.
    const fresh = new EmailIntelligenceService(
      items,
      reminders,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { get: () => undefined } as never,
      {} as never,
      {} as never,
    );
    expect(await fresh.list(me, { view: 'needs_response' })).toHaveLength(0);
    expect(await fresh.list(me, { view: 'responded' })).toHaveLength(1);
    // And a later full sync does not bring it back.
    await sync.syncMyMailbox(me);
    expect(await waiting()).toHaveLength(0);
  });

  it('Test 10 — two employees: one mailbox never changes the other, even with the same conversation id', async () => {
    const other = `${PREFIX}-user-${seq}-b`;
    const otherBox = await connectMailbox(other, `${org}-b`, 'lee@fullypromoted.in');
    const sharedConversation = `${PREFIX}-conv-shared-${seq}`;
    const mine = customerWrites(box, { conversationId: sharedConversation });
    customerWrites(otherBox, { conversationId: sharedConversation, id: `${mine.id}-b`, internetMessageId: mine.internetMessageId });
    await sync.syncMyMailbox(me);
    await sync.syncMyMailbox(other);
    expect(await waiting(me)).toHaveLength(1);
    expect(await waiting(other)).toHaveLength(1);

    repliesInOutlook(box, mine);
    await sync.refreshReplies(me, { force: true });
    await sync.refreshReplies(other, { force: true });
    expect(await waiting(me)).toHaveLength(0);
    expect(await waiting(other)).toHaveLength(1); // the other employee still owes their customer a reply

    const otherRow = (await waiting(other))[0];
    await expect(inboxService.getOne(me, otherRow._id.toString())).rejects.toThrow(/not found/i);
    await expect(inboxService.approve(me, otherRow._id.toString())).rejects.toThrow(/not found/i);
  });

  it('an email already answered in Outlook before the first sync is stored as answered, without an AI call', async () => {
    const question = customerWrites(box);
    repliesInOutlook(box, question);
    await sync.syncMyMailbox(me);
    expect(aiCalls).toHaveLength(0);
    expect(await waiting()).toHaveLength(0);
    expect((await answered())[0]).toMatchObject({ responseStatus: 'responded', respondedVia: 'outlook' });
  });

  it('with no AI credits the email is still stored and tracked, and is read by the AI once credits are back', async () => {
    creditsExhausted = true;
    const question = customerWrites(box);
    const result = await sync.syncMyMailbox(me);
    expect(result).toMatchObject({ newItemsCount: 1, deferredCount: 1 });

    let [row] = await waiting();
    expect(row).toMatchObject({ responseStatus: 'needs_response', analysisState: 'pending' });
    expect(row.reason).toMatch(/credits/i);
    // Hidden by no mail-type filter: its type is simply not known yet.
    expect(await inboxService.list(me, { view: 'needs_response', intents: ['quotation_request'] })).toHaveLength(1);

    // Replying in Outlook is recognised regardless of the AI.
    creditsExhausted = false;
    await sync.syncMyMailbox(me);
    [row] = await waiting();
    expect(row.analysisState).toBeUndefined();
    expect(row).toMatchObject({ intent: 'quotation_request', aiStatus: 'draft_ready' });
    expect(row.draftReply).toBeTruthy();

    repliesInOutlook(box, question);
    await sync.refreshReplies(me, { force: true });
    expect(await waiting()).toHaveLength(0);
  });

  it('when the AI is down the email is not lost either', async () => {
    aiAvailable = false;
    customerWrites(box);
    await sync.syncMyMailbox(me);
    expect(await waiting()).toHaveLength(1);
    const job = await jobs.findOne({ userId: me }).sort({ createdAt: -1 });
    expect(job).toMatchObject({ status: 'completed', newItemsCount: 1, deferredCount: 1, failedCount: 0 });
  });

  it('an email deleted in Outlook stops waiting for a reply', async () => {
    const question = customerWrites(box);
    await sync.syncMyMailbox(me);
    expect(await waiting()).toHaveLength(1);
    question.deleted = true;
    await sync.syncMyMailbox(me);
    expect(await waiting()).toHaveLength(0);
    const [row] = await inboxService.list(me, { view: 'resolved' });
    expect(row).toMatchObject({ mailboxState: 'deleted', category: 'completed' });
  });

  it('mail from one of the mailbox’s own aliases is ours, not a customer waiting', async () => {
    box.aliases.push('sales@fullypromoted.in');
    customerWrites(box, { from: 'sales@fullypromoted.in', subject: 'Note to self' });
    await sync.syncMyMailbox(me);
    expect(aiCalls).toHaveLength(0);
    expect(await waiting()).toHaveLength(0);
    expect((await items.findOne({ userId: me }))!.fromRole).toBe('internal');
    expect((await connections.findOne({ userId: me }))!.addresses).toEqual(expect.arrayContaining(['sam@fullypromoted.in', 'sales@fullypromoted.in']));
  });

  it('a failed sync does not count its window as covered: the next one reads it again', async () => {
    customerWrites(box, { receivedAt: ago(5) });
    http.get.mockImplementationOnce(() => throwError(() => new Error('socket hang up')));
    await expect(sync.syncMyMailbox(me)).rejects.toThrow(/socket hang up/);
    expect(await jobs.findOne({ userId: me })).toMatchObject({ status: 'failed' });
    await sync.syncMyMailbox(me);
    expect(await waiting()).toHaveLength(1);
  });
  it('mail an earlier run failed to store is picked up by the next sync, however long ago that run was', async () => {
    // What the old code left behind: a run that "completed" while dropping its mail.
    const old = new Date(Date.now() - 3 * 24 * 60 * MIN);
    await jobs.create({ organizationId: org, userId: me, status: 'completed_with_errors', triggeredBy: 'scheduled', startedAt: old, completedAt: old, scannedCount: 9, newItemsCount: 8, failedCount: 8 });
    customerWrites(box, { receivedAt: new Date(old.getTime() - 60 * MIN).toISOString() });

    await sync.syncMyMailbox(me);
    expect(await waiting()).toHaveLength(1);
    expect(await jobs.countDocuments({ userId: me, failedCount: { $gt: 0 }, failuresRecovered: true })).toBe(1);
  });
});
