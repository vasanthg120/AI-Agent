import { of, throwError } from 'rxjs';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { JwtService } from '@nestjs/jwt';
import { ChatService } from '../chat/chat.service';
import { ReservationService } from '../billing/reservation.service';
import { GamificationService } from '../gamification/gamification.service';
import { TimelineService } from '../timeline/timeline.service';
import { Deal, DealDocument, DealSchema } from '../crm/schemas/deal.schema';
import { Quote, QuoteDocument, QuoteSchema } from '../crm/schemas/quote.schema';
import { EmailIntelligenceItem, EmailIntelligenceItemDocument, EmailIntelligenceItemSchema } from '../email-intelligence/schemas/email-intelligence-item.schema';
import { DashboardService } from './dashboard.service';
import { DailyReport, DailyReportDocument, DailyReportSchema } from './schemas/daily-report.schema';
import { TasksService } from './tasks.service';

// Real-Mongo integration tests for the additive per-task attribution added to
// recordDailyReport() (resolving relatedDealId/relatedQuoteId/relatedEmailId
// to a real assignedUserId via a direct model lookup — see
// dashboard.module.ts's comment on why Deal/Quote/EmailIntelligenceItem
// models are registered here instead of importing CrmModule/
// EmailIntelligenceModule) and for TasksService.list()'s `mine`-by-default
// filter. Mirrors the TEST_PREFIX + real-Mongo convention every other spec
// in this repo uses.

const TEST_PREFIX = `jest-dashboard-attribution-${Date.now()}`;
const ORG_ID = `${TEST_PREFIX}-org`;
const OWNER_USER_ID = `${TEST_PREFIX}-owner`;
const OTHER_USER_ID = `${TEST_PREFIX}-other`;
const AGENT_ID = 'store_manager';

describe('DashboardService.recordDailyReport — task attribution (real Mongo)', () => {
  let connection: Connection;
  let dashboardService: DashboardService;
  let tasksService: TasksService;
  let reportModel: Model<DailyReportDocument>;
  let dealModel: Model<DealDocument>;
  let quoteModel: Model<QuoteDocument>;
  let emailModel: Model<EmailIntelligenceItemDocument>;
  let httpPost: jest.Mock;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    httpPost = jest.fn();

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: DailyReport.name, schema: DailyReportSchema },
          { name: Deal.name, schema: DealSchema },
          { name: Quote.name, schema: QuoteSchema },
          { name: EmailIntelligenceItem.name, schema: EmailIntelligenceItemSchema },
        ]),
      ],
      providers: [
        DashboardService,
        TasksService,
        { provide: HttpService, useValue: { post: httpPost } },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: JwtService, useValue: { sign: () => 'fake-jwt' } },
        {
          provide: ChatService,
          useValue: {
            listAgents: async () => [{ id: AGENT_ID, name: 'Store Manager', avatarColor: '#000' }],
          },
        },
        {
          provide: ReservationService,
          useValue: {
            resolveTenantKey: (organizationId: string) => organizationId,
            reserve: async () => undefined,
            settle: async () => undefined,
            release: async () => undefined,
          },
        },
        // TasksService's other constructor deps — unused by list(), stubbed
        // only so Nest can instantiate the provider.
        { provide: GamificationService, useValue: {} },
        { provide: TimelineService, useValue: {} },
      ],
    }).compile();

    connection = moduleRef.get(getModelToken(DailyReport.name)).db;
    dashboardService = moduleRef.get(DashboardService);
    tasksService = moduleRef.get(TasksService);
    reportModel = moduleRef.get(getModelToken(DailyReport.name));
    dealModel = moduleRef.get(getModelToken(Deal.name));
    quoteModel = moduleRef.get(getModelToken(Quote.name));
    emailModel = moduleRef.get(getModelToken(EmailIntelligenceItem.name));
  });

  afterAll(async () => {
    await reportModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await dealModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await quoteModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await emailModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await connection.close();
  });

  it('resolves a task with a relatedDealId to the deal owner, and leaves an unresolvable task unassigned', async () => {
    const deal = await dealModel.create({ organizationId: ORG_ID, name: 'Test Deal', ownerId: OWNER_USER_ID });

    httpPost.mockReturnValueOnce(
      of({
        data: {
          reply: 'fake reply',
          summary: 'Test summary',
          tasks: [
            { title: 'Follow up on the deal', priority: 'high', isOverdue: false, relatedDealId: deal._id.toString() },
            { title: 'Generic reminder', priority: 'low', isOverdue: false },
          ],
        },
      }),
    );

    const date = '2099-01-01';
    const saved = await dashboardService.recordDailyReport({
      organizationId: ORG_ID,
      storeId: `${TEST_PREFIX}-store`,
      agentId: AGENT_ID,
      reportType: 'morning',
      date,
      conversationId: 'fake-conversation',
      userId: OWNER_USER_ID,
      userIds: [OWNER_USER_ID, OTHER_USER_ID],
    });

    expect(saved.tasks).toHaveLength(2);
    const attributed = saved.tasks.find((t) => t.title === 'Follow up on the deal');
    const unattributed = saved.tasks.find((t) => t.title === 'Generic reminder');
    expect(attributed?.assignedUserId).toBe(OWNER_USER_ID);
    expect(unattributed?.assignedUserId).toBeUndefined();

    // TasksService.list()'s mine-by-default filter: the owner sees both
    // tasks, a different user sees only the unassigned one — the deal
    // owner's explicitly-assigned task is never shown to someone else.
    const ownerDefaultView = await tasksService.list(
      { dateFrom: date, dateTo: date },
      { sub: OWNER_USER_ID, organizationId: ORG_ID, roles: ['owner'] } as never,
    );
    expect(ownerDefaultView.tasks.map((t) => t.title).sort()).toEqual(['Follow up on the deal', 'Generic reminder']);

    const otherDefaultView = await tasksService.list(
      { dateFrom: date, dateTo: date },
      { sub: OTHER_USER_ID, organizationId: ORG_ID, roles: ['owner'] } as never,
    );
    expect(otherDefaultView.tasks.map((t) => t.title)).toEqual(['Generic reminder']);

    // Explicit mine:false is still the way to reach the old full-board
    // behavior — never the default, but not removed either.
    const fullBoardView = await tasksService.list(
      { dateFrom: date, dateTo: date, mine: false },
      { sub: OTHER_USER_ID, organizationId: ORG_ID, roles: ['owner'] } as never,
    );
    expect(fullBoardView.tasks).toHaveLength(2);

    // calendarSummary() defaults the same way — a non-owner's month heatmap
    // shows only their own + unassigned count for this date.
    const ownerCalendar = await tasksService.calendarSummary(date.slice(0, 7), { sub: OWNER_USER_ID, organizationId: ORG_ID, roles: ['owner'] } as never);
    const otherCalendar = await tasksService.calendarSummary(date.slice(0, 7), { sub: OTHER_USER_ID, organizationId: ORG_ID, roles: ['owner'] } as never);
    expect(ownerCalendar.days.find((d) => d.date === date)?.taskCount).toBe(2);
    expect(otherCalendar.days.find((d) => d.date === date)?.taskCount).toBe(1);
  });

  it('resolves a task with a relatedEmailId to the email owner via externalMessageId (not the Mongo _id)', async () => {
    const externalMessageId = `${TEST_PREFIX}-graph-message-id`;
    await emailModel.create({
      organizationId: ORG_ID,
      userId: OTHER_USER_ID,
      mailboxEmail: 'other@example.com',
      externalMessageId,
      receivedAt: new Date(),
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
    });

    httpPost.mockReturnValueOnce(
      of({
        data: {
          reply: 'fake reply',
          summary: 'Test summary',
          tasks: [{ title: 'Reply to customer email', priority: 'high', isOverdue: false, relatedEmailId: externalMessageId }],
        },
      }),
    );

    const date = '2099-01-03';
    const saved = await dashboardService.recordDailyReport({
      organizationId: ORG_ID,
      storeId: `${TEST_PREFIX}-store-3`,
      agentId: AGENT_ID,
      reportType: 'morning',
      date,
      conversationId: 'fake-conversation-3',
      userId: OWNER_USER_ID,
    });

    expect(saved.tasks[0].assignedUserId).toBe(OTHER_USER_ID);
  });

  it('never leaks another organization\'s tasks regardless of the mine filter', async () => {
    const otherOrgId = `${TEST_PREFIX}-org-2`;
    httpPost.mockReturnValueOnce(
      of({ data: { reply: 'r', summary: 's', tasks: [{ title: 'Org B task', priority: 'low', isOverdue: false }] } }),
    );
    const date = '2099-01-04';
    await dashboardService.recordDailyReport({
      organizationId: otherOrgId,
      storeId: `${TEST_PREFIX}-store-b`,
      agentId: AGENT_ID,
      reportType: 'morning',
      date,
      conversationId: 'fake-conversation-b',
      userId: OWNER_USER_ID, // same user id, different org — must not matter
    });

    const orgAView = await tasksService.list({ dateFrom: date, dateTo: date }, { sub: OWNER_USER_ID, organizationId: ORG_ID, roles: ['owner'] } as never);
    const orgAViewFullBoard = await tasksService.list(
      { dateFrom: date, dateTo: date, mine: false },
      { sub: OWNER_USER_ID, organizationId: ORG_ID, roles: ['owner'] } as never,
    );
    expect(orgAView.tasks.some((t) => t.title === 'Org B task')).toBe(false);
    expect(orgAViewFullBoard.tasks.some((t) => t.title === 'Org B task')).toBe(false);

    await reportModel.deleteMany({ organizationId: otherOrgId });
  });

  it('never fails the whole report when reserve/settle succeed but the http call errors, and releases the reservation', async () => {
    httpPost.mockReturnValueOnce(throwError(() => new Error('python-agent unreachable')));
    await expect(
      dashboardService.recordDailyReport({
        organizationId: ORG_ID,
        storeId: `${TEST_PREFIX}-store-2`,
        agentId: AGENT_ID,
        reportType: 'eod',
        date: '2099-01-02',
        conversationId: 'fake-conversation-2',
        userId: OWNER_USER_ID,
      }),
    ).rejects.toThrow('python-agent unreachable');
  });
});
