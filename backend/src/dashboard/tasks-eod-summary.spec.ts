import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { ChatService } from '../chat/chat.service';
import { GamificationService } from '../gamification/gamification.service';
import { TimelineService } from '../timeline/timeline.service';
import { Account, AccountDocument, AccountSchema } from '../crm/schemas/account.schema';
import { Contact, ContactDocument, ContactSchema } from '../crm/schemas/contact.schema';
import { Deal, DealDocument, DealSchema } from '../crm/schemas/deal.schema';
import { Quote, QuoteDocument, QuoteSchema } from '../crm/schemas/quote.schema';
import { EmailIntelligenceItem, EmailIntelligenceItemDocument, EmailIntelligenceItemSchema } from '../email-intelligence/schemas/email-intelligence-item.schema';
import { DailyReport, DailyReportDocument, DailyReportSchema } from './schemas/daily-report.schema';
import { TasksService } from './tasks.service';

// Real-Mongo integration tests for TasksService.getEodSummary() — the new,
// real (non-LLM) aggregation behind the EOD page. Every figure asserted here
// is a live count against a real fixture, matching the method's own "never
// fabricate a number" design (see its own doc comment).

const TEST_PREFIX = `jest-eod-summary-${Date.now()}`;
const ORG_ID = `${TEST_PREFIX}-org`;
const USER_ID = `${TEST_PREFIX}-user`;
const OTHER_USER_ID = `${TEST_PREFIX}-other-user`;

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

describe('TasksService.getEodSummary (real Mongo)', () => {
  let connection: Connection;
  let tasksService: TasksService;
  let reportModel: Model<DailyReportDocument>;
  let dealModel: Model<DealDocument>;
  let quoteModel: Model<QuoteDocument>;
  let contactModel: Model<ContactDocument>;
  let accountModel: Model<AccountDocument>;
  let emailModel: Model<EmailIntelligenceItemDocument>;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: DailyReport.name, schema: DailyReportSchema },
          { name: Deal.name, schema: DealSchema },
          { name: Quote.name, schema: QuoteSchema },
          { name: Contact.name, schema: ContactSchema },
          { name: Account.name, schema: AccountSchema },
          { name: EmailIntelligenceItem.name, schema: EmailIntelligenceItemSchema },
        ]),
      ],
      providers: [
        TasksService,
        { provide: HttpService, useValue: {} },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: JwtService, useValue: { sign: () => 'fake-jwt' } },
        // getEodSummary() calls list() internally, which resolves the
        // caller's allowed agent ids via ChatService.listAgents — must
        // include 'store_manager' (the agentId the fixture report below
        // uses) or list() would filter that report's tasks out entirely.
        { provide: ChatService, useValue: { listAgents: async () => [{ id: 'store_manager', name: 'Store Manager', avatarColor: '#000' }] } },
        { provide: GamificationService, useValue: {} },
        { provide: TimelineService, useValue: {} },
      ],
    }).compile();

    connection = moduleRef.get(getModelToken(DailyReport.name)).db;
    tasksService = moduleRef.get(TasksService);
    reportModel = moduleRef.get(getModelToken(DailyReport.name));
    dealModel = moduleRef.get(getModelToken(Deal.name));
    quoteModel = moduleRef.get(getModelToken(Quote.name));
    contactModel = moduleRef.get(getModelToken(Contact.name));
    accountModel = moduleRef.get(getModelToken(Account.name));
    emailModel = moduleRef.get(getModelToken(EmailIntelligenceItem.name));
  });

  afterAll(async () => {
    await reportModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await dealModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await quoteModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await contactModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await accountModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await emailModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await connection.close();
  });

  it('aggregates real, current-user, today-only counts across tasks/email/CRM, and reuses the existing EOD report narrative', async () => {
    const date = todayStamp();
    const now = new Date();

    // A deal/quote owned by USER_ID, created+updated today — must count.
    await dealModel.create({ organizationId: ORG_ID, name: 'Today Deal', ownerId: USER_ID, dealStatus: 'open' });
    await quoteModel.create({ organizationId: ORG_ID, quoteNumber: 'Q-EOD-1', quoteAmount: 100, currency: 'INR', ownerUserId: USER_ID });

    // A deal owned by a DIFFERENT user — must never count toward USER_ID's summary.
    await dealModel.create({ organizationId: ORG_ID, name: 'Other User Deal', ownerId: OTHER_USER_ID, dealStatus: 'open' });

    // Real store-wide contact/account created today.
    await contactModel.create({ organizationId: ORG_ID, name: 'New Contact Today' });
    await accountModel.create({ organizationId: ORG_ID, name: 'New Account Today' });

    // A relevant-intent email received today by USER_ID, and replied to
    // today via the app (sentAt) — counts as both received and responded.
    await emailModel.create({
      organizationId: ORG_ID,
      userId: USER_ID,
      mailboxEmail: 'user@example.com',
      externalMessageId: `${TEST_PREFIX}-msg-1`,
      receivedAt: now,
      sentAt: now,
      fromAddress: 'customer@example.com',
      intent: 'new_enquiry',
      priority: 'high',
      urgency: 'high',
      sentiment: 'neutral',
      recommendedAction: 'Reply with pricing',
      shouldDraft: true,
      deterministicInput: {},
      result: {},
      aiStatus: 'draft_ready',
      status: 'approved',
    });

    // The scheduled crew's own EOD report for today — its summary must be
    // reused verbatim, never regenerated.
    await reportModel.create({
      organizationId: ORG_ID,
      agentId: 'store_manager',
      reportType: 'eod',
      date,
      tasks: [{ title: 'Done today', priority: 'medium', status: 'done', isOverdue: false }],
      summary: 'A real EOD narrative from the scheduled crew run.',
      sourceConversationId: 'fake-conversation',
      sourceUserId: USER_ID,
    });

    const caller = { sub: USER_ID, organizationId: ORG_ID, roles: ['consultant'] } as never;
    const summary = await tasksService.getEodSummary(caller);

    expect(summary.date).toBe(date);
    expect(summary.crm.dealsCreated).toBe(1);
    expect(summary.crm.dealsUpdated).toBe(1);
    expect(summary.crm.quotesCreated).toBe(1);
    expect(summary.crm.quotesUpdated).toBe(1);
    expect(summary.email.received).toBe(1);
    expect(summary.email.sent).toBe(1);
    expect(summary.email.responded).toBe(1);
    expect(summary.newContactsAcrossOrg).toBeGreaterThanOrEqual(1);
    expect(summary.newAccountsAcrossOrg).toBeGreaterThanOrEqual(1);
    expect(summary.reportExists).toBe(true);
    expect(summary.narrativeSummary).toBe('A real EOD narrative from the scheduled crew run.');
    expect(summary.tasksCompleted.some((t) => t.title === 'Done today')).toBe(true);
  });

  it('reports reportExists:false and a null narrative when no EOD report has been generated for today', async () => {
    const orgWithNoReport = `${TEST_PREFIX}-org-empty`;
    const caller = { sub: USER_ID, organizationId: orgWithNoReport, roles: ['consultant'] } as never;
    const summary = await tasksService.getEodSummary(caller);

    expect(summary.reportExists).toBe(false);
    expect(summary.narrativeSummary).toBeNull();
    expect(summary.crm.dealsCreated).toBe(0);
    expect(summary.email.received).toBe(0);
  });

  // The EOD page's Calendar view — pass an explicit past date and get that
  // date's own report/counts, never today's, so clicking a date in the past
  // actually shows that day instead of silently showing "today" regardless.
  it('looks up a past date explicitly, not always today', async () => {
    const orgHistorical = `${TEST_PREFIX}-org-historical`;
    const pastDate = '2020-06-15';

    await dealModel.create({ organizationId: orgHistorical, name: 'Historical Deal', ownerId: USER_ID, dealStatus: 'won', createdAt: new Date(`${pastDate}T10:00:00.000Z`) });
    await reportModel.create({
      organizationId: orgHistorical,
      agentId: 'store_manager',
      reportType: 'eod',
      date: pastDate,
      tasks: [],
      summary: 'A historical EOD narrative.',
      sourceConversationId: 'fake-conversation-historical',
      sourceUserId: USER_ID,
    });

    const caller = { sub: USER_ID, organizationId: orgHistorical, roles: ['consultant'] } as never;
    const historical = await tasksService.getEodSummary(caller, pastDate);
    const today = await tasksService.getEodSummary(caller);

    expect(historical.date).toBe(pastDate);
    expect(historical.reportExists).toBe(true);
    expect(historical.narrativeSummary).toBe('A historical EOD narrative.');
    expect(historical.crm.dealsCreated).toBe(1);
    // The Deal's createdAt was forced to pastDate — it must never leak into
    // "today"'s own count for the same org.
    expect(today.crm.dealsCreated).toBe(0);
    expect(today.reportExists).toBe(false);
  });

  it('falls back to today for a malformed date instead of building a garbage query', async () => {
    const caller = { sub: USER_ID, organizationId: `${TEST_PREFIX}-org-malformed`, roles: ['consultant'] } as never;
    const summary = await tasksService.getEodSummary(caller, 'not-a-date');
    expect(summary.date).toBe(todayStamp());
  });
});
