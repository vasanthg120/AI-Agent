import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Model, Types } from 'mongoose';
import { INBOX_BOXES, InboxBox, inboxBoxMatch, inboxBoxOf } from './email-inbox-boxes';
import { EmailIntelligenceService } from './email-intelligence.service';
import { EmailIntelligenceItem, EmailIntelligenceItemDocument, EmailIntelligenceItemSchema } from './schemas/email-intelligence-item.schema';

// The inbox's boxes ("New enquiries", "Need to reply", … "Junk & automated")
// replaced the mail-type filter that let junk through. Every email must be in
// exactly one box, the Mongo rules and the per-email rule must agree, and
// anything still owed a reply can never end up in junk.
describe('AI Email Inbox — boxes (real Mongo)', () => {
  let items: Model<EmailIntelligenceItemDocument>;
  let service: EmailIntelligenceService;
  const userId = new Types.ObjectId().toString();
  const orgId = `jest-boxes-${Date.now()}-org`;
  let seq = 0;

  const email = (expected: InboxBox, extra: Record<string, unknown>) =>
    items
      .create({
        organizationId: orgId,
        userId,
        mailboxEmail: 'enquiry@example.com',
        externalMessageId: `${orgId}-${++seq}`,
        receivedAt: new Date(Date.now() - seq * 60_000),
        subject: `${expected} ${seq}`,
        fromAddress: `person${seq}@customer.com`,
        toAddresses: ['enquiry@example.com'],
        bodyPreview: '',
        isRead: false,
        importance: 'normal',
        matchConfidence: 'none',
        intent: 'existing_customer',
        priority: 'medium',
        urgency: 'medium',
        sentiment: 'neutral',
        recommendedAction: 'Reply',
        shouldDraft: true,
        fromRole: 'customer',
        expectedNextAction: 'company_reply',
        deterministicInput: { source: 'test' },
        result: { source: 'test' },
        ...extra,
      })
      .then((doc) => ({ doc, expected }));

  const replied = { externalReplyDetectedAt: new Date(), replyMatchedVia: 'conversation' };
  const noReply = { expectedNextAction: 'no_action_required', shouldDraft: false, aiStatus: 'no_reply_needed' };

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');
    const moduleRef = await Test.createTestingModule({
      imports: [MongooseModule.forRoot(uri), MongooseModule.forFeature([{ name: EmailIntelligenceItem.name, schema: EmailIntelligenceItemSchema }])],
    }).compile();
    items = moduleRef.get(getModelToken(EmailIntelligenceItem.name));
    service = new EmailIntelligenceService(
      items,
      {} as never,
      { create: jest.fn(async () => undefined) } as never,
      {} as never,
      {} as never,
      { findById: async () => null, findAll: async () => [] } as never,
      { post: jest.fn(), get: jest.fn() } as never,
      { sign: () => 'token' } as never,
      { get: () => undefined } as never,
      {} as never,
      {} as never,
    );
  });

  afterAll(async () => {
    await items.deleteMany({ organizationId: orgId });
    await items.db.close();
  });

  it('puts every kind of email in exactly one box — and the list, the counts and the email agree', async () => {
    const all = await Promise.all([
      email('new_enquiries', { intent: 'new_enquiry' }),
      email('new_enquiries', { intent: 'quotation_request' }),
      email('to_reply', { intent: 'existing_customer' }),
      email('to_reply', { intent: 'complaint' }),
      // Not read by the AI yet (no credits): could be a customer, so it waits for a reply.
      email('to_reply', { intent: 'other', analysisState: 'pending' }),
      // The AI called it "other" but said it needs an answer: never hidden in junk.
      email('to_reply', { intent: 'other' }),
      email('awaiting_customer', { intent: 'new_enquiry', ...replied, replyAwaitsCustomer: true }),
      email('replied', { intent: 'existing_customer', ...replied }),
      email('no_reply', { intent: 'existing_customer', ...noReply }),
      email('no_reply', { intent: 'vendor', status: 'rejected' }),
      email('junk', { intent: 'other', ...noReply }),
      email('junk', { intent: 'spam', ...noReply }),
      email('junk', { intent: 'internal', ...noReply, fromRole: 'internal' }),
    ]);

    for (const { doc, expected } of all) {
      expect({ subject: doc.subject, box: inboxBoxOf(doc) }).toEqual({ subject: doc.subject, box: expected });
      expect(doc.toJSON()).toMatchObject({ inboxBox: expected });
      const inBoxes: InboxBox[] = [];
      for (const box of INBOX_BOXES) if (await items.countDocuments({ _id: doc._id, ...inboxBoxMatch(box) })) inBoxes.push(box);
      expect({ subject: doc.subject, boxes: inBoxes }).toEqual({ subject: doc.subject, boxes: [expected] });
    }

    const counts = await service.counts(userId);
    const expectedCounts = Object.fromEntries(INBOX_BOXES.map((box) => [box, all.filter((e) => e.expected === box).length]));
    expect(counts.boxes).toEqual(expectedCounts);
    for (const box of INBOX_BOXES) {
      const listed = await service.list(userId, { box, limit: 100 });
      expect(listed.map((d) => d.subject).sort()).toEqual(all.filter((e) => e.expected === box).map((e) => e.doc.subject).sort());
    }
  });
});
