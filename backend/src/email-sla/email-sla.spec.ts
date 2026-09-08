import { ConfigService } from '@nestjs/config';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { ChatGateway } from '../chat/chat.gateway';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Notification, NotificationDocument, NotificationSchema } from '../notifications/schemas/notification.schema';
import { WebPushService } from '../notifications/web-push.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { UsersService } from '../users/users.service';
import { EmailSlaCalculatorService } from './email-sla-calculator.service';
import { EmailSlaEscalationService } from './email-sla-escalation.service';
import { EmailSlaPolicyService } from './email-sla-policy.service';
import { EmailSlaService } from './email-sla.service';
import { BusinessHoursConfig, BusinessHoursConfigSchema } from './schemas/business-hours-config.schema';
import { EmailEscalationRule, EmailEscalationRuleDocument, EmailEscalationRuleSchema } from './schemas/email-escalation-rule.schema';
import { EmailSlaEvent, EmailSlaEventDocument, EmailSlaEventSchema } from './schemas/email-sla-event.schema';
import { EmailSlaPolicy, EmailSlaPolicySchema } from './schemas/email-sla-policy.schema';
import { EmailSlaRecord, EmailSlaRecordDocument, EmailSlaRecordSchema } from './schemas/email-sla-record.schema';

// Real-Mongo integration tests for the Email SLA module. Feature-flagged
// (emailSla.enabled/escalationEnabled) — the fake ConfigService below keeps
// both on for these tests, mirroring how an environment that's actually
// adopted the feature would run.

const TEST_PREFIX = `jest-email-sla-${Date.now()}`;

describe('Email SLA (real Mongo)', () => {
  let connection: Connection;
  let slaService: EmailSlaService;
  let escalationService: EmailSlaEscalationService;
  let policyService: EmailSlaPolicyService;
  let recordModel: Model<EmailSlaRecordDocument>;
  let eventModel: Model<EmailSlaEventDocument>;
  let ruleModel: Model<EmailEscalationRuleDocument>;
  let notificationModel: Model<NotificationDocument>;

  const configValues: Record<string, unknown> = {
    'emailSla.enabled': true,
    'emailSla.escalationEnabled': true,
  };

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: EmailSlaRecord.name, schema: EmailSlaRecordSchema },
          { name: EmailSlaEvent.name, schema: EmailSlaEventSchema },
          { name: EmailSlaPolicy.name, schema: EmailSlaPolicySchema },
          { name: BusinessHoursConfig.name, schema: BusinessHoursConfigSchema },
          { name: EmailEscalationRule.name, schema: EmailEscalationRuleSchema },
          { name: Notification.name, schema: NotificationSchema },
        ]),
      ],
      providers: [
        EmailSlaService,
        EmailSlaCalculatorService,
        EmailSlaPolicyService,
        EmailSlaEscalationService,
        NotificationsService,
        { provide: ConfigService, useValue: { get: (key: string) => configValues[key] } },
        // NotificationsService's real dependencies — stubbed rather than
        // wired live, same reasoning as every other real-Mongo spec in this
        // repo that only needs NotificationsService.create() to not throw.
        { provide: ChatGateway, useValue: { emitToUser: () => undefined } },
        { provide: UsersService, useValue: { findAll: async () => [], findById: async () => null } },
        { provide: OrganizationsService, useValue: {} },
        { provide: MailService, useValue: { send: async () => undefined } },
        { provide: WebPushService, useValue: { sendToUser: async () => undefined } },
      ],
    }).compile();

    connection = moduleRef.get(getModelToken(EmailSlaRecord.name)).db;
    slaService = moduleRef.get(EmailSlaService);
    escalationService = moduleRef.get(EmailSlaEscalationService);
    policyService = moduleRef.get(EmailSlaPolicyService);
    recordModel = moduleRef.get(getModelToken(EmailSlaRecord.name));
    eventModel = moduleRef.get(getModelToken(EmailSlaEvent.name));
    ruleModel = moduleRef.get(getModelToken(EmailEscalationRule.name));
    notificationModel = moduleRef.get(getModelToken(Notification.name));
  });

  afterAll(async () => {
    await recordModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await eventModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await ruleModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await notificationModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await connection.close();
  });

  it('creates a record with the right slaDueAt, and never duplicates it on a second call', async () => {
    const organizationId = `${TEST_PREFIX}-dedup`;
    const receivedAt = new Date('2026-03-02T09:00:00.000Z'); // Monday 09:00 UTC
    const email = { organizationId, emailId: 'email-1', assignedUserId: 'user-1', receivedAt, priority: 'urgent', aiStatus: 'draft_ready' };

    await slaService.createOrUpdateRecordForItem(email);
    await slaService.createOrUpdateRecordForItem(email); // second call must be a no-op

    const records = await recordModel.find({ organizationId, emailId: 'email-1' }).exec();
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('PENDING');
    // Default UTC business hours 09:00-18:00, urgent=30min -> due 09:30.
    expect(records[0].slaDueAt.toISOString()).toBe('2026-03-02T09:30:00.000Z');

    const events = await eventModel.find({ organizationId, recordId: records[0]._id.toString() }).exec();
    expect(events.filter((e) => e.type === 'created')).toHaveLength(1);
  });

  it('never creates a record for an email the classification already decided needs no reply', async () => {
    const organizationId = `${TEST_PREFIX}-ineligible`;
    await slaService.createOrUpdateRecordForItem({
      organizationId,
      emailId: 'email-2',
      assignedUserId: 'user-1',
      receivedAt: new Date(),
      priority: 'high',
      aiStatus: 'no_reply_needed',
    });
    const record = await recordModel.findOne({ organizationId, emailId: 'email-2' }).exec();
    expect(record).toBeNull();
  });

  it('flags a response sent before the due time as on-time, and after it as breached', async () => {
    const organizationId = `${TEST_PREFIX}-first-response`;
    const receivedAt = new Date('2026-03-02T09:00:00.000Z');

    await slaService.createOrUpdateRecordForItem({ organizationId, emailId: 'email-on-time', assignedUserId: 'user-1', receivedAt, priority: 'urgent', aiStatus: 'draft_ready' });
    await slaService.recordFirstResponse(organizationId, 'email-on-time', new Date('2026-03-02T09:20:00.000Z')); // before 09:30 due
    const onTime = await recordModel.findOne({ organizationId, emailId: 'email-on-time' }).exec();
    expect(onTime?.status).toBe('RESPONDED');
    expect(onTime?.isBreached).toBe(false);
    expect(onTime?.responseTimeSeconds).toBe(20 * 60);

    await slaService.createOrUpdateRecordForItem({ organizationId, emailId: 'email-late', assignedUserId: 'user-1', receivedAt, priority: 'urgent', aiStatus: 'draft_ready' });
    await slaService.recordFirstResponse(organizationId, 'email-late', new Date('2026-03-02T10:00:00.000Z')); // after 09:30 due
    const late = await recordModel.findOne({ organizationId, emailId: 'email-late' }).exec();
    expect(late?.isBreached).toBe(true);
  });

  it('breach cron marks overdue records exactly once and does not re-process already-breached ones', async () => {
    const organizationId = `${TEST_PREFIX}-breach-idempotent`;
    const pastDue = new Date(Date.now() - 60_000);
    await recordModel.create({
      organizationId,
      emailId: 'email-overdue',
      assignedUserId: 'user-1',
      receivedAt: new Date(Date.now() - 3_600_000),
      slaStartedAt: new Date(Date.now() - 3_600_000),
      slaDueAt: pastDue,
      status: 'PENDING',
      priority: 'urgent',
    });

    await escalationService.scanForBreachesAndEscalations();
    const afterFirstTick = await recordModel.findOne({ organizationId, emailId: 'email-overdue' }).exec();
    expect(afterFirstTick?.status).toBe('BREACHED');
    const firstBreachedAt = afterFirstTick?.breachedAt?.getTime();

    await escalationService.scanForBreachesAndEscalations();
    const afterSecondTick = await recordModel.findOne({ organizationId, emailId: 'email-overdue' }).exec();
    expect(afterSecondTick?.breachedAt?.getTime()).toBe(firstBreachedAt); // untouched — not re-processed

    const breachEvents = await eventModel.find({ organizationId, recordId: afterFirstTick!._id.toString(), type: 'breached' }).exec();
    expect(breachEvents).toHaveLength(1);
  });

  it('escalation levels fire in order, exactly once each, never both on the same tick unless both delays have elapsed', async () => {
    const organizationId = `${TEST_PREFIX}-escalation`;
    await ruleModel.create([
      { organizationId, priority: 'urgent', escalationLevel: 1, delayMinutes: 0, notifyAssignedUser: true, enabled: true },
      { organizationId, priority: 'urgent', escalationLevel: 2, delayMinutes: 30, notifyAssignedUser: true, enabled: true },
    ]);

    const record = await recordModel.create({
      organizationId,
      emailId: 'email-escalate',
      assignedUserId: `${TEST_PREFIX}-assignee`,
      receivedAt: new Date(Date.now() - 3_600_000),
      slaStartedAt: new Date(Date.now() - 3_600_000),
      slaDueAt: new Date(Date.now() - 60_000),
      status: 'PENDING',
      priority: 'urgent',
    });

    // Tick 1: breaches, then immediately qualifies for level 1 (delayMinutes:0).
    await escalationService.scanForBreachesAndEscalations();
    let current = await recordModel.findById(record._id).exec();
    expect(current?.status).toBe('ESCALATED');
    expect(current?.escalationLevel).toBe(1);

    // Tick 2, immediately after: level 2 needs 30 minutes since breach —
    // must NOT fire yet.
    await escalationService.scanForBreachesAndEscalations();
    current = await recordModel.findById(record._id).exec();
    expect(current?.escalationLevel).toBe(1);

    // Simulate 30+ minutes having passed since breach.
    await recordModel.updateOne({ _id: record._id }, { $set: { breachedAt: new Date(Date.now() - 31 * 60_000) } });
    await escalationService.scanForBreachesAndEscalations();
    current = await recordModel.findById(record._id).exec();
    expect(current?.escalationLevel).toBe(2);

    const escalationEvents = await eventModel.find({ organizationId, recordId: record._id.toString(), type: 'escalated' }).exec();
    expect(escalationEvents).toHaveLength(2); // exactly one per level, never duplicated
  });

  it('policy resolution falls back to the documented default when nothing is configured, and reflects an admin override once one exists', async () => {
    const organizationId = `${TEST_PREFIX}-policy`;
    const defaultPolicy = await policyService.resolvePolicy(organizationId, 'high');
    expect(defaultPolicy.firstResponseTimeMinutes).toBe(120); // DEFAULT_PRIORITY_SLA_MINUTES.high

    await policyService.upsertPolicy(organizationId, 'high', { firstResponseTimeMinutes: 45 });
    const overridden = await policyService.resolvePolicy(organizationId, 'high');
    expect(overridden.firstResponseTimeMinutes).toBe(45);
  });
});
