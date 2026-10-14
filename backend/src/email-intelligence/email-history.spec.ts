import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { of } from 'rxjs';
import { OutlookConnection, OutlookConnectionDocument, OutlookConnectionSchema } from '../outlook/schemas/outlook-connection.schema';
import { EmailConversationService } from './email-conversation.service';
import { EmailHistoryService } from './email-history.service';
import { deriveResponseStatus } from './email-response-state';
import { EmailFollowUpReminder, EmailFollowUpReminderDocument, EmailFollowUpReminderSchema } from './schemas/email-follow-up-reminder.schema';
import { EmailIntelligenceItem, EmailIntelligenceItemDocument, EmailIntelligenceItemSchema } from './schemas/email-intelligence-item.schema';
import { EmailSentItem, EmailSentItemDocument, EmailSentItemSchema } from './schemas/email-sent-item.schema';

const PREFIX = `jest-hist-${Date.now()}`;
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

// Against a real Mongo, with Outlook faked: older mail is brought in without
// an AI call, "answered or not" comes from the thread's own sent messages, and
// follow-ups are read from what was actually written.
describe('Email history & follow-up analysis (real Mongo)', () => {
  let connection: Connection;
  let items: Model<EmailIntelligenceItemDocument>;
  let sent: Model<EmailSentItemDocument>;
  let reminders: Model<EmailFollowUpReminderDocument>;
  let connections: Model<OutlookConnectionDocument>;
  let service: EmailHistoryService;
  const http = { get: jest.fn() };
  let seq = 0;
  let org: string;
  let user: string;

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
        ]),
      ],
    }).compile();
    connection = moduleRef.get(getConnectionToken());
    items = moduleRef.get(getModelToken(EmailIntelligenceItem.name));
    sent = moduleRef.get(getModelToken(EmailSentItem.name));
    reminders = moduleRef.get(getModelToken(EmailFollowUpReminder.name));
    connections = moduleRef.get(getModelToken(OutlookConnection.name));
    await Promise.all([items.init(), sent.init(), reminders.init()]);
  });

  beforeEach(() => {
    seq += 1;
    org = `${PREFIX}-org-${seq}`;
    user = `${PREFIX}-user-${seq}`;
    http.get.mockReset();
    // The real response-state engine, without the SLA side-effects.
    const conversations = new EmailConversationService(items, sent, connections, { recordFirstResponse: async () => undefined } as never);
    service = new EmailHistoryService(
      items,
      sent,
      reminders,
      connections,
      {} as never, // EmailIntelligenceService — not exercised here
      conversations,
      {
        gatherCorrelationContext: async () => ({
          exactEmails: new Set(),
          domains: new Set(),
          businessNamesForFuzzy: [],
          emailToGroupKey: new Map(),
          domainToGroupKey: new Map(),
          groups: new Map(),
        }),
      } as never,
      { findById: async () => ({ organizationId: org, name: 'Sam' }) } as never,
      http as never,
      { sign: () => 'jwt' } as never,
      { get: () => 'http://agent' } as never,
    );
  });

  afterAll(async () => {
    const mine = { organizationId: { $regex: `^${PREFIX}` } };
    await items.deleteMany(mine);
    await sent.deleteMany(mine);
    await reminders.deleteMany(mine);
    await connections.deleteMany({ userId: { $regex: `^${PREFIX}` } });
    await connection.close();
  });

  const inbox = (id: string, from: string, receivedAt: string, extra: Record<string, unknown> = {}) => ({
    id,
    from,
    to: ['sam@fullypromoted.in'],
    subject: `Subject ${id}`,
    receivedAt,
    preview: `Preview ${id}`,
    isRead: true,
    importance: 'normal',
    conversationId: `conv-${id}`,
    ...extra,
  });
  const outbox = (id: string, conversationId: string, sentAt: string, preview = 'Thanks, noted.') => ({ id, conversationId, sentAt, subject: 'RE', to: ['x@y.com'], preview });
  const connect = () => connections.collection.insertOne({ userId: user, email: 'sam@fullypromoted.in', isActive: true, accessToken: 'x', refreshToken: 'x', expiresAt: new Date() });
  const fakeOutlook = (inboxMessages: unknown[], sentMessages: unknown[], truncated = false) =>
    http.get.mockImplementation((_url: string, options: { params: { folder: string } }) =>
      of({ data: { connected: true, messages: options.params.folder === 'inbox' ? inboxMessages : sentMessages, truncated } }),
    );

  it('imports older inbox and sent mail without AI calls, and works out who is owed a reply', async () => {
    await connect();
    fakeOutlook(
      [
        inbox('answered', 'buyer@acme.com', daysAgo(40)),
        inbox('waiting', 'lead@globex.com', daysAgo(12)),
        inbox('colleague', 'priya@fullypromoted.in', daysAgo(9)),
        inbox('robot', 'no-reply@shipping.com', daysAgo(8)),
        inbox('news', 'hello@brand.com', daysAgo(7), { preview: 'Big sale! Unsubscribe here' }),
        inbox('bounce', 'postmaster@mail.com', daysAgo(6)),
      ],
      [outbox('s1', 'conv-answered', daysAgo(39)), outbox('s2', 'conv-other', daysAgo(3))],
      true,
    );

    const result = await service.importHistory(user, 90);
    expect(result).toEqual({ connected: true, days: 90, inboxScanned: 6, inboxAdded: 6, sentScanned: 2, sentAdded: 2, markedResponded: 1, truncated: true });
    expect(http.get).toHaveBeenCalledTimes(2);
    expect(http.get.mock.calls[0][0]).toBe('http://agent/outlook/history');

    const stored = await items.find({ userId: user }).exec();
    const state = Object.fromEntries(stored.map((i) => [i.externalMessageId, deriveResponseStatus(i)]));
    expect(state).toEqual({ answered: 'responded', waiting: 'needs_response', colleague: 'resolved', robot: 'resolved', news: 'resolved', bounce: 'resolved' });
    const waiting = stored.find((i) => i.externalMessageId === 'waiting')!;
    expect(waiting).toMatchObject({ organizationId: org, fromRole: 'external_other', shouldDraft: false, status: 'pending' });
    expect(waiting.deterministicInput).toMatchObject({ skippedLlmCall: true, reasonForSkip: 'history import' });

    // Repeating the import adds nothing.
    const again = await service.importHistory(user, 90);
    expect(again).toMatchObject({ inboxAdded: 0, sentAdded: 0, markedResponded: 0 });
    expect(await items.countDocuments({ userId: user })).toBe(6);

    const status = await service.status(user);
    expect(status).toMatchObject({ inboxCount: 6, sentCount: 2 });
    expect((await service.listSent(user, { search: 're' })).total).toBe(2);
    // Another user sees none of it.
    expect((await service.listSent(`${user}-other`, {})).total).toBe(0);
    expect(await service.status(`${user}-other`)).toMatchObject({ inboxCount: 0, sentCount: 0 });
  });

  it('reports not connected, and rejects a nonsense range', async () => {
    await expect(service.importHistory(user, 30)).resolves.toMatchObject({ connected: false, inboxAdded: 0 });
    expect(http.get).not.toHaveBeenCalled();
    await expect(service.importHistory(user, 0)).rejects.toThrow('Choose how many days');
  });

  it('sorts threads into not responded / follow-up required / overdue from what was actually written', async () => {
    await connect();
    fakeOutlook(
      [
        inbox('fresh', 'new@lead.com', new Date(Date.now() - 2 * 3_600_000).toISOString()),
        inbox('old', 'old@lead.com', daysAgo(6)),
        inbox('promised', 'ask@buyer.com', daysAgo(10)),
        inbox('kept', 'kept@buyer.com', daysAgo(10)),
        inbox('silent', 'silent@buyer.com', daysAgo(12)),
        inbox('chatty', 'chatty@buyer.com', daysAgo(12)),
        inbox('chatty2', 'chatty@buyer.com', daysAgo(2), { conversationId: 'conv-chatty' }),
      ],
      [
        outbox('p1', 'conv-promised', daysAgo(8), 'Hi, I will get back to you with the quote by Monday.'),
        outbox('k1', 'conv-kept', daysAgo(8), 'We will send the samples tomorrow.'),
        outbox('k2', 'conv-kept', daysAgo(7), 'Samples dispatched, tracking attached.'),
        outbox('q1', 'conv-silent', daysAgo(9), 'Please find our quotation attached.'),
        outbox('c1', 'conv-chatty', daysAgo(11), 'Here are the details you asked for.'),
      ],
    );
    await service.importHistory(user, 60);

    const { counts, rows } = await service.followUpAnalysis(user);
    const bySubject = Object.fromEntries(rows.map((r) => [r.subject, r]));

    // Customer emails nobody answered — the old one is urgent, with how long it has waited.
    expect(bySubject['Subject fresh']).toMatchObject({ bucket: 'not_responded', kind: 'unanswered', customer: 'new@lead.com', daysWaiting: 0 });
    expect(bySubject['Subject old']).toMatchObject({ bucket: 'not_responded', priority: 'urgent', daysWaiting: 6 });
    expect(bySubject['Subject old'].reason).toContain('6 days ago');
    // The customer wrote again after our reply: that new message is what's waiting.
    expect(bySubject['Subject chatty2']).toMatchObject({ bucket: 'not_responded' });
    expect(bySubject['Subject chatty']).toBeUndefined();

    // "I will get back to you…" with nothing sent since: an overdue promised follow-up.
    expect(bySubject['Subject promised']).toMatchObject({ bucket: 'overdue_follow_up', kind: 'promised_follow_up', daysWaiting: 8 });
    expect(bySubject['Subject promised'].reason).toContain('I will get back to you with the quote by Monday');
    expect(bySubject['Subject promised'].reminderId).toBeDefined();
    // A promise that was kept (something was sent afterwards) is not flagged as a promise…
    expect(rows.filter((r) => r.kind === 'promised_follow_up')).toHaveLength(1);
    // …those threads are simply waiting on the customer, and overdue after a week of silence.
    expect(bySubject['Subject kept']).toMatchObject({ bucket: 'overdue_follow_up', kind: 'awaiting_customer' });
    expect(bySubject['Subject silent']).toMatchObject({ bucket: 'overdue_follow_up', kind: 'awaiting_customer', daysWaiting: 9 });

    expect(counts).toEqual({ responded: 4, not_responded: 3, follow_up_required: 0, overdue_follow_up: 3 });

    // Keeping the promise closes its reminder on the next pass.
    await service.storeSent(org, user, 'sam@fullypromoted.in', [outbox('p2', 'conv-promised', new Date().toISOString(), 'Quote attached as promised.')]);
    await service.maintainFollowUps(user);
    expect(await reminders.countDocuments({ userId: user, reminderType: 'promised_follow_up', status: 'pending' })).toBe(0);

    // An "awaiting the customer" row can become a reminder (for the draft → approve → send flow), once.
    const silent = await items.findOne({ userId: user, externalMessageId: 'silent' }).exec();
    const first = await service.ensureReminder(user, silent!._id.toString());
    const second = await service.ensureReminder(user, silent!._id.toString());
    expect(second._id.toString()).toBe(first._id.toString());
    await expect(service.ensureReminder(`${user}-other`, silent!._id.toString())).rejects.toThrow('could not be found');
  });
});
