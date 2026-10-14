import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { of, throwError } from 'rxjs';
import { EmailHistoryService } from './email-history.service';
import { EmailIntelligenceService } from './email-intelligence.service';
import { EmailFollowUpReminder, EmailFollowUpReminderDocument, EmailFollowUpReminderSchema } from './schemas/email-follow-up-reminder.schema';
import { EmailIntelligenceItem, EmailIntelligenceItemDocument, EmailIntelligenceItemSchema } from './schemas/email-intelligence-item.schema';

// Follow-up drafts in the AI Email Inbox, against a real Mongo and the real
// service (only the python-agent call and the wallet are stubbed). The bug
// this guards: "Draft follow-up" answered "AI follow-up draft generation is
// not enabled for this environment" — a person's click was refused by a
// switch meant for drafts nobody asked for.
const PREFIX = `jest-followup-draft-${Date.now()}`;
const DAY = 86_400_000;

describe('AI Email Inbox — follow-up drafts (real Mongo)', () => {
  let connection: Connection;
  let items: Model<EmailIntelligenceItemDocument>;
  let reminders: Model<EmailFollowUpReminderDocument>;
  let service: EmailIntelligenceService;
  let history: EmailHistoryService;
  let httpPost: jest.Mock;
  let reservations: { reserve: jest.Mock; settle: jest.Mock; release: jest.Mock; resolveTenantKey: (org: string) => string };
  let seq = 0;
  let userId: string;
  let orgId: string;
  // What the environment switch says. Off — as it is wherever it was never set — unless a test turns it on.
  let automaticDrafts = false;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: EmailIntelligenceItem.name, schema: EmailIntelligenceItemSchema },
          { name: EmailFollowUpReminder.name, schema: EmailFollowUpReminderSchema },
        ]),
      ],
    }).compile();
    items = moduleRef.get(getModelToken(EmailIntelligenceItem.name));
    reminders = moduleRef.get(getModelToken(EmailFollowUpReminder.name));
    connection = items.db;
  });

  beforeEach(() => {
    seq += 1;
    userId = `${PREFIX}-user-${seq}`;
    orgId = `${PREFIX}-org-${seq}`;
    automaticDrafts = false;
    httpPost = jest.fn(() => of({ data: { draftReply: 'Hi Priya — just checking whether the quotation works for you.' } }));
    reservations = {
      reserve: jest.fn(async () => undefined),
      settle: jest.fn(async () => undefined),
      release: jest.fn(async () => undefined),
      resolveTenantKey: (org) => org,
    };
    service = new EmailIntelligenceService(
      items,
      reminders,
      { create: jest.fn(async () => undefined) } as never, // notifications
      { getRelationshipView: jest.fn(async () => ({})) } as never, // customerActivity
      {} as never, // quotes
      { findById: async () => null, findAll: async () => [] } as never, // users
      { post: httpPost, get: jest.fn() } as never,
      { sign: () => 'token' } as never,
      { get: (key: string) => (key === 'emailSla.aiFollowupActionsEnabled' ? automaticDrafts : undefined) } as never,
      { recordFirstResponse: jest.fn(async () => undefined), createOrUpdateRecordForItem: jest.fn() } as never, // email SLA
      reservations as never,
    );
    // Only ensureReminder is exercised: it reads the email and the reminder, nothing else.
    const unused = {} as never;
    history = new EmailHistoryService(items, unused, reminders, unused, unused, unused, unused, unused, unused, unused, { get: () => undefined } as never);
  });

  afterAll(async () => {
    await items.deleteMany({ userId: { $regex: `^${PREFIX}` } });
    await reminders.deleteMany({ userId: { $regex: `^${PREFIX}` } });
    await connection.close();
  });

  async function email() {
    return items.create({
      organizationId: orgId,
      userId,
      mailboxEmail: 'me@example.com',
      externalMessageId: `${PREFIX}-msg-${++seq}`,
      conversationId: `${PREFIX}-conv-${seq}`,
      receivedAt: new Date(Date.now() - 6 * DAY),
      subject: 'Quote for 200 polo shirts',
      fromAddress: 'priya@example.com',
      bodyPreview: 'Please send your best price.',
      intent: 'quotation_request',
      priority: 'high',
      urgency: 'high',
      sentiment: 'neutral',
      recommendedAction: 'Reply with a quote',
      shouldDraft: true,
      status: 'approved',
      sentAt: new Date(Date.now() - 5 * DAY),
      finalDraftReply: 'Hi Priya — the quotation is attached.',
      deterministicInput: { fixture: true },
      result: { fixture: true },
    });
  }

  const reminderFor = (item: EmailIntelligenceItemDocument, over: Record<string, unknown> = {}) =>
    reminders.create({
      organizationId: orgId,
      userId,
      emailIntelligenceItemId: item._id.toString(),
      reminderType: 'post_reply',
      title: 'Follow up: Quote',
      dueDate: new Date(),
      status: 'pending',
      draftStatus: 'none',
      ...over,
    });

  it('writes the draft when a person asks, whatever the environment switch says', async () => {
    const reminder = await reminderFor(await email());

    const drafted = await service.generateFollowUpDraft(userId, reminder._id.toString());

    expect(drafted).toMatchObject({ draftStatus: 'pending_review', draftReply: expect.stringContaining('checking whether the quotation') });
    expect(drafted.draftGeneratedAt).toBeInstanceOf(Date);
    // Billed like any other AI button: reserved, then settled against the very call that was made.
    const requestId = reservations.reserve.mock.calls[0][2];
    expect(reservations.reserve).toHaveBeenCalledWith(orgId, userId, requestId, 'email-ai-followup');
    expect(httpPost.mock.calls[0][0]).toMatch(/\/business-intelligence\/followups\/draft$/);
    expect(httpPost.mock.calls[0][1]).toMatchObject({
      request_id: requestId,
      originalSubject: 'Quote for 200 polo shirts',
      ourPreviousReply: 'Hi Priya — the quotation is attached.',
    });
    expect(reservations.settle).toHaveBeenCalledWith(requestId);
    expect(reservations.release).not.toHaveBeenCalled();
    // It is in the list, ready to be reviewed.
    expect((await service.listFollowUps(userId)).map((r) => r.draftStatus)).toEqual(['pending_review']);
  });

  it('says so when there are no credits, and changes nothing', async () => {
    const reminder = await reminderFor(await email());
    reservations.reserve.mockRejectedValue(new HttpException({ message: 'Your Haive Credits are exhausted.' }, HttpStatus.PAYMENT_REQUIRED));

    await expect(service.generateFollowUpDraft(userId, reminder._id.toString())).rejects.toMatchObject({ status: HttpStatus.PAYMENT_REQUIRED });

    expect(httpPost).not.toHaveBeenCalled();
    expect((await reminders.findById(reminder._id))!.draftStatus).toBe('none');
  });

  it('a draft that could not be written is marked failed, costs nothing and can be asked for again', async () => {
    const reminder = await reminderFor(await email());
    httpPost.mockReturnValueOnce(throwError(() => new Error('agent down')));

    expect((await service.generateFollowUpDraft(userId, reminder._id.toString())).draftStatus).toBe('failed');
    expect(reservations.release).toHaveBeenCalledTimes(1);
    expect(reservations.settle).not.toHaveBeenCalled();

    expect((await service.generateFollowUpDraft(userId, reminder._id.toString())).draftStatus).toBe('pending_review');
  });

  it('drafts written with nobody asking stay behind the switch', async () => {
    const item = await email();
    const breach = { organizationId: orgId, emailId: item._id.toString(), assignedUserId: userId, slaRecordId: 'sla-1' };

    await service.createSlaBreachFollowUp(breach);
    expect(await reminders.countDocuments({ userId })).toBe(0);
    expect(httpPost).not.toHaveBeenCalled();

    automaticDrafts = true;
    httpPost.mockReturnValue(
      of({ data: { draftReply: 'Here is the price you asked for.', usedThreadMessages: 1, usedCrmContext: false, usedBusinessKnowledge: false } }),
    );
    await service.createSlaBreachFollowUp(breach);
    expect(await reminders.find({ userId }).lean()).toEqual([expect.objectContaining({ reminderType: 'sla_breach', draftStatus: 'pending_review' })]);
  });

  it('a reminder left "generating" by an interrupted draft recovers, so it can be asked for again', async () => {
    const item = await email();
    const stuck = await reminderFor(item, { draftStatus: 'generating' });
    // Mongoose stamps updatedAt itself; put it in the past the way an interrupted draft would have left it.
    await reminders.collection.updateOne({ _id: stuck._id }, { $set: { updatedAt: new Date(Date.now() - 10 * 60_000) } });
    const fresh = await reminderFor(await email(), { draftStatus: 'generating' });

    const listed = await service.listFollowUps(userId);
    const status = (id: unknown) => listed.find((r) => String(r._id) === String(id))!.draftStatus;
    expect(status(stuck._id)).toBe('failed');
    // One that only just started is left alone.
    expect(status(fresh._id)).toBe('generating');
  });

  it('a follow-up that is due again starts a new round on the same reminder', async () => {
    const item = await email();
    const sent = await reminderFor(item, { status: 'done', draftStatus: 'sent', draftReply: 'First follow-up.', sentAt: new Date(Date.now() - 4 * DAY) });
    // Closed and sent: it cannot be drafted or sent a second time as it stands.
    await expect(service.generateFollowUpDraft(userId, sent._id.toString())).rejects.toBeInstanceOf(BadRequestException);

    const reopened = await history.ensureReminder(userId, item._id.toString());

    expect(String(reopened._id)).toBe(String(sent._id));
    expect(reopened).toMatchObject({ status: 'pending', draftStatus: 'none' });
    expect(reopened.sentAt).toBeUndefined();
    expect(reopened.draftReply).toBeUndefined();
    expect((await service.generateFollowUpDraft(userId, reopened._id.toString())).draftStatus).toBe('pending_review');
    // An open reminder is returned as it is — asking twice never wipes a draft.
    expect((await history.ensureReminder(userId, item._id.toString())).draftStatus).toBe('pending_review');
  });
});
