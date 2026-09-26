import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import {
  deriveRespondedInfo,
  deriveResponseStatus,
  EmailResponseStatus,
  needsResponseMatch,
  responseStatusMatch,
} from './email-response-state';
import {
  EmailIntelligenceItem,
  EmailIntelligenceItemDocument,
  EmailIntelligenceItemSchema,
} from './schemas/email-intelligence-item.schema';

const NOW = new Date('2026-09-24T10:00:00Z');
const LATER = new Date('2026-09-24T11:00:00Z');

// Every situation an item can be in, and what the inbox must call it. The same
// table drives the pure-function test and the Mongo-filter test below, so the
// two definitions of "needs a reply" can never drift apart.
const CASES: { name: string; item: Record<string, unknown>; expected: EmailResponseStatus }[] = [
  { name: 'fresh email the AI drafted a reply for', item: { status: 'pending', shouldDraft: true, expectedNextAction: 'company_reply', aiStatus: 'draft_ready' }, expected: 'needs_response' },
  { name: 'draft approved but not sent yet', item: { status: 'approved', shouldDraft: true, expectedNextAction: 'company_reply', aiStatus: 'draft_ready' }, expected: 'needs_response' },
  { name: 'approved, send FAILED (sendError, no sentAt)', item: { status: 'approved', shouldDraft: true, expectedNextAction: 'company_reply', aiStatus: 'draft_ready', sendError: 'Graph 503' }, expected: 'needs_response' },
  { name: 'AI draft discarded — a person must write the reply', item: { status: 'pending', shouldDraft: false, expectedNextAction: 'no_action_required', aiStatus: 'validation_failed' }, expected: 'needs_response' },
  { name: 'older email from before the AI recorded a verdict, draft wanted', item: { status: 'pending', shouldDraft: true }, expected: 'needs_response' },
  { name: 'reply sent through the app', item: { status: 'approved', shouldDraft: true, expectedNextAction: 'company_reply', sentAt: NOW }, expected: 'responded' },
  { name: 'reply typed directly into Outlook (status still pending)', item: { status: 'pending', shouldDraft: true, expectedNextAction: 'company_reply', externalReplyDetectedAt: NOW }, expected: 'responded' },
  { name: 'approved draft, then answered in Outlook instead', item: { status: 'approved', shouldDraft: true, expectedNextAction: 'company_reply', externalReplyDetectedAt: NOW }, expected: 'responded' },
  { name: 'older message covered by a later reply in its thread', item: { status: 'pending', shouldDraft: true, expectedNextAction: 'company_reply', threadRespondedAt: NOW }, expected: 'responded' },
  { name: 'rejected AND later answered — answered wins', item: { status: 'rejected', shouldDraft: true, expectedNextAction: 'company_reply', externalReplyDetectedAt: NOW }, expected: 'responded' },
  { name: 'AI says no reply needed', item: { status: 'pending', shouldDraft: false, expectedNextAction: 'no_action_required', aiStatus: 'no_reply_needed' }, expected: 'resolved' },
  { name: 'we are waiting on the customer', item: { status: 'pending', shouldDraft: false, expectedNextAction: 'awaiting_customer', aiStatus: 'awaiting_customer_response' }, expected: 'resolved' },
  { name: 'rejected by the user', item: { status: 'rejected', shouldDraft: true, expectedNextAction: 'company_reply' }, expected: 'resolved' },
  { name: 'approved as "no reply needed"', item: { status: 'approved', shouldDraft: false, expectedNextAction: 'no_action_required', aiStatus: 'validation_failed' }, expected: 'resolved' },
  { name: 'older email with no draft wanted', item: { status: 'pending', shouldDraft: false }, expected: 'resolved' },
];

describe('email response state — pure derivation', () => {
  it.each(CASES)('$name -> $expected', ({ item, expected }) => {
    expect(deriveResponseStatus(item)).toBe(expected);
  });

  it('reports how and when it was answered, preferring the message\'s own send', () => {
    expect(deriveRespondedInfo({ sentAt: NOW, externalReplyDetectedAt: LATER })).toEqual({ respondedAt: NOW, respondedVia: 'app' });
    expect(deriveRespondedInfo({ externalReplyDetectedAt: NOW })).toEqual({ respondedAt: NOW, respondedVia: 'outlook' });
    expect(deriveRespondedInfo({ threadRespondedAt: NOW })).toEqual({ respondedAt: NOW, respondedVia: 'thread' });
    expect(deriveRespondedInfo({})).toEqual({});
  });

  it('never treats read state, priority or a re-analysis as a reply', () => {
    const open = { status: 'pending', shouldDraft: true, expectedNextAction: 'company_reply' };
    expect(deriveResponseStatus({ ...open, isRead: true } as never)).toBe('needs_response');
    expect(deriveResponseStatus({ ...open, aiStatus: 'draft_ready', regeneratedCount: 3 } as never)).toBe('needs_response');
  });
});

// The same cases, asked of Mongo. Real database (like the billing specs): the
// filters use $nor/$and/$exists, whose behaviour is exactly what a mock can't prove.
describe('email response state — Mongo filters agree with the pure function (real Mongo)', () => {
  const ORG = `jest-response-state-${Date.now()}`;
  let connection: Connection;
  let model: Model<EmailIntelligenceItemDocument>;
  const idsByCase = new Map<string, string>();

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

    for (const [i, c] of CASES.entries()) {
      const doc = await model.create({
        organizationId: ORG,
        userId: `${ORG}-user`,
        mailboxEmail: 'me@example.com',
        externalMessageId: `${ORG}-msg-${i}`,
        receivedAt: NOW,
        fromAddress: 'customer@example.com',
        intent: 'new_enquiry',
        priority: 'medium',
        urgency: 'medium',
        sentiment: 'neutral',
        recommendedAction: 'x',
        deterministicInput: {},
        result: {},
        ...c.item,
      });
      idsByCase.set(c.name, doc._id.toString());
    }
  });

  afterAll(async () => {
    await model.deleteMany({ organizationId: ORG });
    await connection.close();
  });

  it.each<EmailResponseStatus>(['needs_response', 'responded', 'resolved'])('the %s filter finds exactly the cases the function calls %s', async (view) => {
    const found = await model.find({ organizationId: ORG, ...responseStatusMatch(view) }).select('_id').lean().exec();
    const foundIds = new Set(found.map((d) => d._id.toString()));
    const expectedIds = new Set(CASES.filter((c) => c.expected === view).map((c) => idsByCase.get(c.name)!));
    expect(foundIds).toEqual(expectedIds);
  });

  it('every item lands in exactly one view (the three views partition the inbox)', async () => {
    const [a, b, c] = await Promise.all(
      (['needs_response', 'responded', 'resolved'] as const).map((view) =>
        model.countDocuments({ organizationId: ORG, ...responseStatusMatch(view) }).exec(),
      ),
    );
    expect(a + b + c).toBe(CASES.length);
  });

  it('needsResponseMatch() is the needs_response filter', async () => {
    const count = await model.countDocuments({ organizationId: ORG, ...needsResponseMatch() }).exec();
    expect(count).toBe(CASES.filter((c) => c.expected === 'needs_response').length);
  });

  it('the serialized document carries the derived state, never stored', async () => {
    const id = idsByCase.get('reply typed directly into Outlook (status still pending)')!;
    const doc = await model.findById(id).exec();
    const json = doc!.toJSON() as unknown as Record<string, unknown>;
    expect(json.responseStatus).toBe('responded');
    expect(json.respondedVia).toBe('outlook');
    expect(json).not.toHaveProperty('id');
    const raw = await model.collection.findOne({ _id: doc!._id });
    expect(raw).not.toHaveProperty('responseStatus');
  });
});
